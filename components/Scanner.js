class Scanner {
    static MAX_IMAGE_DIMENSION = 1800;
    static PDF_RENDER_SCALE = 2;
    static NON_TRANSACTION_TERMS = [
        'balance', 'available', 'account', 'statement', 'activity', 'ending',
        'routing', 'member fdic', 'search', 'filter', 'deposit account',
        'total', 'subtotal', 'summary', 'details', 'merchant', 'description',
        'transactions', 'transaction history', 'current balance', 'posted date',
        'sapphire', 'preferred', 'card', 'ending in', 'manage', 'rewards'
    ];

    static async processFiles(fileElement, statusCallback) {
        if (!fileElement.files || fileElement.files.length === 0) return [];

        let allTransactions = [];

        for (let i = 0; i < fileElement.files.length; i += 1) {
            const file = fileElement.files[i];
            statusCallback(`Reading file ${i + 1} of ${fileElement.files.length}...`);

            try {
                if (!this.isSupportedFile(file)) {
                    statusCallback(`File ${i + 1} is not a supported image or PDF.`);
                    continue;
                }

                let transactions = [];
                if (this.isPdfFile(file)) {
                    transactions = await this.processPdf(file, statusCallback, i + 1, fileElement.files.length);
                } else {
                    transactions = await this.processImageFile(file, statusCallback, i + 1, fileElement.files.length);
                }

                allTransactions = allTransactions.concat(transactions);
            } catch (error) {
                console.error(error);
                statusCallback(`Could not read file ${i + 1}. Try a clearer image or a text-based PDF.`);
            }
        }

        return allTransactions;
    }

    static isSupportedFile(file) {
        const type = (file.type || '').toLowerCase();
        if (type.startsWith('image/') || type === 'application/pdf') return true;

        const name = (file.name || '').toLowerCase();
        return ['.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif', '.pdf'].some(ext => name.endsWith(ext));
    }

    static isPdfFile(file) {
        const type = (file.type || '').toLowerCase();
        const name = (file.name || '').toLowerCase();
        return type === 'application/pdf' || name.endsWith('.pdf');
    }

    static async processImageFile(file, statusCallback, fileNumber, totalFiles) {
        const image = await this.loadImageFile(file);
        const variants = this.prepareImageVariants(image);
        let bestTransactions = [];
        let bestScore = -Infinity;

        for (const variant of variants) {
            statusCallback(`Scanning image ${fileNumber}/${totalFiles} (${variant.label})...`);
            const ocrText = await this.runOcrOnCanvas(variant.canvas, message => {
                statusCallback(`Scanning image ${fileNumber}/${totalFiles} (${variant.label})... ${message}%`);
            });
            const transactions = this.parseText(ocrText);
            const score = this.scoreParseResult(transactions);

            if (score > bestScore) {
                bestScore = score;
                bestTransactions = transactions;
            }

            if (transactions.length > 0) {
                break;
            }
        }

        return bestTransactions;
    }

    static async processPdf(file, statusCallback, fileNumber, totalFiles) {
        if (!window.pdfjsLib) {
            throw new Error('PDF support is still loading. Refresh and try again.');
        }

        const buffer = await file.arrayBuffer();
        const loadingTask = window.pdfjsLib.getDocument({ data: buffer });
        const pdf = await loadingTask.promise;
        let allTransactions = [];

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            statusCallback(`Reading PDF ${fileNumber}/${totalFiles}, page ${pageNumber}/${pdf.numPages}...`);
            const page = await pdf.getPage(pageNumber);
            let activeDate = '';

            const textLines = await this.extractPdfTextLines(page);
            let parsed = this.parseLinesWithState(textLines, activeDate);
            let transactions = parsed.transactions;
            activeDate = parsed.lastActiveDate;

            if (transactions.length === 0) {
                const viewport = page.getViewport({ scale: this.PDF_RENDER_SCALE });
                const canvas = document.createElement('canvas');
                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);
                const context = canvas.getContext('2d', { willReadFrequently: true });
                await page.render({ canvasContext: context, viewport }).promise;

                const prepared = this.prepareCanvasForOCR(canvas, { mode: 'balanced' });
                const ocrText = await this.runOcrOnCanvas(prepared, progress => {
                    statusCallback(`Scanning PDF ${fileNumber}/${totalFiles}, page ${pageNumber}/${pdf.numPages}... ${progress}%`);
                });
                parsed = this.parseTextWithState(ocrText, activeDate);
                transactions = parsed.transactions;
                activeDate = parsed.lastActiveDate;
            }

            allTransactions = allTransactions.concat(transactions);
        }

        return allTransactions;
    }

    static async extractPdfTextLines(page) {
        const textContent = await page.getTextContent();
        const items = textContent.items
            .map(item => ({
                text: (item.str || '').trim(),
                x: item.transform[4],
                y: item.transform[5]
            }))
            .filter(item => item.text);

        if (items.length === 0) return [];

        items.sort((left, right) => {
            if (Math.abs(left.y - right.y) > 4) {
                return right.y - left.y;
            }
            return left.x - right.x;
        });

        const lines = [];
        items.forEach(item => {
            const existing = lines.find(line => Math.abs(line.y - item.y) <= 4);
            if (existing) {
                existing.parts.push(item);
            } else {
                lines.push({ y: item.y, parts: [item] });
            }
        });

        return lines
            .map(line => line.parts.sort((a, b) => a.x - b.x).map(part => part.text).join(' ').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
    }

    static parseText(rawText) {
        return this.parseTextWithState(rawText, '').transactions;
    }

    static parseLines(lines) {
        return this.parseLinesWithState(lines, '').transactions;
    }

    static parseTextWithState(rawText, initialDate = '') {
        return this.parseLinesWithState(this.prepareLines(rawText), initialDate);
    }

    static parseLinesWithState(lines, initialDate = '') {
        const transactions = [];
        const dateRegex = /\b(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|[A-Za-z]{3,9}\s\d{1,2}(?:,\s?\d{2,4})?)\b/;
        let activeDate = initialDate || '';

        lines.forEach((line, index) => {
            const normalizedLine = this.normalizeText(line);
            const dateMatch = normalizedLine.match(dateRegex);
            let lineDate = '';

            if (dateMatch) {
                lineDate = this.normalizeDate(dateMatch[0]);
            }

            if (lineDate && !this.lineHasAmount(normalizedLine)) {
                activeDate = lineDate;
                return;
            }

            const amountMatch = this.extractAmountToken(normalizedLine);
            if (!amountMatch) return;

            const amount = this.parseAmount(amountMatch);
            if (!this.isReasonableAmount(amount)) return;
            if (!this.isLikelyTransactionLine(normalizedLine)) return;

            const name = this.extractTransactionName(lines, index, amountMatch, dateRegex);
            if (!this.isLikelyMerchantName(name)) return;

            const categorized = CategorizationEngine.categorize(name, CategorizationEngine.guessType(name, amountMatch));
            transactions.push({
                date: lineDate || activeDate,
                name,
                amount,
                type: categorized.type,
                category: categorized.c,
                subCategory: categorized.s
            });

            if (lineDate) {
                activeDate = lineDate;
            }
        });

        return {
            transactions,
            lastActiveDate: activeDate
        };
    }

    static prepareLines(rawText) {
        return (rawText || '')
            .split('\n')
            .map(line => this.normalizeText(line))
            .filter(Boolean);
    }

    static normalizeText(text) {
        return (text || '')
            .replace(/[|]/g, ' ')
            .replace(/[Oo](?=\d{2}\b)/g, '0')
            .replace(/(?<=\d)[oO](?=\d)/g, '0')
            .replace(/[Ss](?=\d{2}\b)/g, '5')
            .replace(/[,](?=\d{2}\b)/g, '.')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    static lineHasAmount(line) {
        return Boolean(this.extractAmountToken(line));
    }

    static extractAmountToken(line) {
        if (!line) return '';
        const matches = [...line.matchAll(/[+\-]?\$?\s*\d[\d,\s]*(?:[.]\d{2})/g)];
        if (matches.length !== 1) return '';

        const amountToken = matches[0][0].trim();
        if (!/\.\d{2}\b/.test(amountToken)) return '';
        if (/^\d{1,2}:\d{2}$/.test(amountToken)) return '';
        return amountToken;
    }

    static parseAmount(token) {
        const normalized = String(token || '')
            .replace(/[Oo]/g, '0')
            .replace(/[$,\s]/g, '')
            .replace(/[^0-9.+-]/g, '');

        const parsed = parseFloat(normalized);
        return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
    }

    static isReasonableAmount(amount) {
        return amount >= 0.01 && amount <= 50000;
    }

    static isLikelyTransactionLine(line) {
        const lower = line.toLowerCase();
        if (this.NON_TRANSACTION_TERMS.some(term => lower.includes(term))) return false;

        const digitCount = (line.match(/\d/g) || []).length;
        const alphaCount = (line.match(/[A-Za-z]/g) || []).length;
        if (digitCount > 18 && alphaCount < 4) return false;
        return true;
    }

    static extractTransactionName(lines, index, amountToken, dateRegex) {
        const current = this.cleanNameCandidate(
            lines[index]
                .replace(new RegExp(this.escapeRegExp(amountToken), 'g'), ' ')
                .replace(dateRegex, ' ')
        );

        const previous = index > 0 ? this.cleanNameCandidate(lines[index - 1].replace(dateRegex, ' ')) : '';
        const next = index + 1 < lines.length ? this.cleanNameCandidate(lines[index + 1].replace(dateRegex, ' ')) : '';

        if (this.isStrongMerchantName(current)) {
            if (this.looksLikeContinuation(next) && !this.lineHasAmount(lines[index + 1] || '')) {
                return this.cleanNameCandidate(`${current} ${next}`);
            }
            return current;
        }

        if (previous && !this.lineHasAmount(lines[index - 1] || '') && this.isStrongMerchantName(previous)) {
            if (current && this.looksLikeContinuation(current)) {
                return this.cleanNameCandidate(`${previous} ${current}`);
            }
            return previous;
        }

        if (current) return current;
        if (next && !this.lineHasAmount(lines[index + 1] || '')) return next;
        return '';
    }

    static cleanNameCandidate(text) {
        const cleaned = (text || '')
            .replace(/[\u25A0-\u25FF\u2600-\u27BF]/g, ' ')
            .replace(/\b(pending|posted|complete|completed|debit|credit|purchase|payment|online|transaction|card|tap|contactless|available|authorized)\b/gi, ' ')
            .replace(/\b(today|yesterday|details|view|merchant|statement|activity|balance|account|ending|total|subtotal|summary|transactions|history|search|filter)\b/gi, ' ')
            .replace(/\b\d{2}:\d{2}\b/g, ' ')
            .replace(/\b\d{4,}\b/g, ' ')
            .replace(/^[^A-Za-z0-9]+/g, ' ')
            .replace(/^[-:•.*]+/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();

        return cleaned;
    }

    static isLikelyMerchantName(name) {
        if (!name) return false;
        const lower = name.toLowerCase();
        if (this.NON_TRANSACTION_TERMS.some(term => lower.includes(term))) return false;

        const alphaCount = (name.match(/[A-Za-z]/g) || []).length;
        const words = name.split(' ').filter(Boolean);
        if (alphaCount < 3) return false;
        if (words.length === 0) return false;
        if (/^\d+$/.test(name)) return false;
        return true;
    }

    static isStrongMerchantName(name) {
        if (!this.isLikelyMerchantName(name)) return false;
        const alphaCount = (name.match(/[A-Za-z]/g) || []).length;
        return alphaCount >= 5;
    }

    static looksLikeContinuation(text) {
        if (!text) return false;
        const words = text.split(' ').filter(Boolean);
        return words.length <= 3 || /-$/.test(text) || text === text.toUpperCase();
    }

    static normalizeDate(input) {
        if (!input) return '';

        const currentYear = new Date().getFullYear();
        let value = input.replace(/-/g, '/').trim();
        if (!/\d{4}/.test(value)) {
            value = value.includes('/') ? `${value}/${currentYear}` : `${value}, ${currentYear}`;
        }

        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return '';

        const month = String(parsed.getMonth() + 1).padStart(2, '0');
        const day = String(parsed.getDate()).padStart(2, '0');
        return `${parsed.getFullYear()}-${month}-${day}`;
    }

    static async loadImageFile(file) {
        const dataUrl = await this.readFileAsDataUrl(file);
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = dataUrl;
        });
    }

    static readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    static prepareImageVariants(image) {
        return [
            { label: 'balanced', canvas: this.prepareImageForOCR(image, { mode: 'balanced' }) },
            { label: 'high contrast', canvas: this.prepareImageForOCR(image, { mode: 'contrast' }) }
        ];
    }

    static prepareImageForOCR(image, options = {}) {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const scale = Math.min(1, this.MAX_IMAGE_DIMENSION / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));

        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        return this.prepareCanvasForOCR(canvas, options);
    }

    static prepareCanvasForOCR(canvas, options = {}) {
        const clone = document.createElement('canvas');
        clone.width = canvas.width;
        clone.height = canvas.height;
        const context = clone.getContext('2d', { willReadFrequently: true });
        context.drawImage(canvas, 0, 0);

        const imageData = context.getImageData(0, 0, clone.width, clone.height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
            const grayscale = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            let nextValue = grayscale;

            if (options.mode === 'contrast') {
                nextValue = grayscale > 165 ? 255 : grayscale < 135 ? 0 : grayscale;
            } else {
                nextValue = grayscale > 190 ? 255 : grayscale < 100 ? 0 : grayscale;
            }

            data[i] = nextValue;
            data[i + 1] = nextValue;
            data[i + 2] = nextValue;
        }

        context.putImageData(imageData, 0, 0);
        return clone;
    }

    static async runOcrOnCanvas(canvas, progressCallback) {
        const result = await Tesseract.recognize(canvas, 'eng', {
            logger: message => {
                if (message.status === 'recognizing text' && progressCallback) {
                    progressCallback(Math.round(message.progress * 100));
                }
            }
        });

        return result.data.text || '';
    }

    static scoreParseResult(transactions) {
        const namedTransactions = transactions.filter(tx => tx.name && tx.name !== 'Unknown Vendor').length;
        const datedTransactions = transactions.filter(tx => tx.date).length;
        return (transactions.length * 100) + (namedTransactions * 20) + datedTransactions;
    }

    static escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

window.Scanner = Scanner;
