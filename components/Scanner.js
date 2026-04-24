class Scanner {
    static MAX_IMAGE_DIMENSION = 1800;
    static PDF_RENDER_SCALE = 3;
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

            if (this.shouldUsePdfOcr(textLines, transactions)) {
                parsed = await this.scanPdfPageWithOcrVariants(page, activeDate, statusCallback, fileNumber, totalFiles, pageNumber, pdf.numPages);
                if (
                    this.shouldPreferPdfOcr(textLines, transactions, parsed.transactions) ||
                    this.scoreParseResult(parsed.transactions) > this.scoreParseResult(transactions)
                ) {
                    transactions = parsed.transactions;
                    activeDate = parsed.lastActiveDate;
                }
            }

            allTransactions = allTransactions.concat(transactions);
        }

        return allTransactions;
    }

    static async scanPdfPageWithOcrVariants(page, activeDate, statusCallback, fileNumber, totalFiles, pageNumber, pageCount) {
        const variants = [
            { label: 'balanced', scale: this.PDF_RENDER_SCALE, mode: 'balanced' },
            { label: 'high contrast', scale: this.PDF_RENDER_SCALE, mode: 'contrast' },
            { label: 'plain render', scale: this.PDF_RENDER_SCALE, mode: 'none' },
            { label: 'smaller render', scale: 2, mode: 'balanced' }
        ];
        let bestParsed = { transactions: [], lastActiveDate: activeDate };
        let bestScore = -Infinity;

        for (const variant of variants) {
            const canvas = await this.renderPdfPageToCanvas(page, variant.scale);
            const prepared = this.prepareCanvasForOCR(canvas, { mode: variant.mode });
            const ocrData = await this.runOcrDataOnCanvas(prepared, progress => {
                statusCallback(`Scanning PDF ${fileNumber}/${totalFiles}, page ${pageNumber}/${pageCount} (${variant.label})... ${progress}%`);
            });
            const parsed = this.parsePdfOcrDataWithState(ocrData, activeDate);
            const score = this.scoreParseResult(parsed.transactions);

            if (score > bestScore) {
                bestScore = score;
                bestParsed = parsed;
            }

            if (parsed.transactions.length >= 5 && parsed.transactions.filter(tx => tx.date).length >= 3) {
                break;
            }
        }

        return bestParsed;
    }

    static async renderPdfPageToCanvas(page, scale) {
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport }).promise;
        return canvas;
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

    static parsePdfOcrDataWithState(ocrData, initialDate = '') {
        const positionedLines = this.extractOcrPositionedLines(ocrData);
        if (positionedLines.length > 0) {
            const parsed = this.parseLinesWithState(positionedLines, initialDate);
            if (parsed.transactions.length > 0) {
                return parsed;
            }
        }

        return this.parseTextWithState((ocrData && ocrData.text) || '', initialDate);
    }

    static extractOcrPositionedLines(ocrData) {
        const words = ((ocrData && ocrData.words) || [])
            .map(word => {
                const bbox = word.bbox || {};
                const text = this.normalizeText(word.text || '');
                const y0 = Number(bbox.y0);
                const y1 = Number(bbox.y1);
                const x0 = Number(bbox.x0);
                const x1 = Number(bbox.x1);

                return {
                    text,
                    x0,
                    x1,
                    y: Number.isFinite(y0) && Number.isFinite(y1) ? (y0 + y1) / 2 : NaN,
                    height: Number.isFinite(y0) && Number.isFinite(y1) ? Math.max(1, y1 - y0) : 12
                };
            })
            .filter(word => word.text && Number.isFinite(word.x0) && Number.isFinite(word.y));

        if (words.length === 0) return [];

        const averageHeight = words.reduce((sum, word) => sum + word.height, 0) / words.length;
        const rowTolerance = Math.max(8, averageHeight * 0.55);
        const rows = [];

        words
            .sort((a, b) => a.y - b.y || a.x0 - b.x0)
            .forEach(word => {
                const row = rows.find(candidate => Math.abs(candidate.y - word.y) <= rowTolerance);
                if (row) {
                    row.words.push(word);
                    row.y = (row.y * (row.words.length - 1) + word.y) / row.words.length;
                } else {
                    rows.push({ y: word.y, words: [word] });
                }
            });

        return rows
            .sort((a, b) => a.y - b.y)
            .map(row => row.words.sort((a, b) => a.x0 - b.x0).map(word => word.text).join(' '))
            .map(line => this.normalizeText(line))
            .filter(Boolean);
    }

    static parseLinesWithState(lines, initialDate = '') {
        const transactions = [];
        const dateRegex = this.dateTokenRegex();
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

            if (!lineDate && this.isLikelyBalanceCarryoverLine(lines, index, normalizedLine, dateRegex)) {
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
            .replace(/\u00a0/g, ' ')
            .replace(/\u2212/g, '-')
            .replace(/[\u2013\u2014]/g, '-')
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
        const tokens = this.extractAmountTokens(line);
        if (tokens.length === 0) return '';

        if (tokens.length === 1) {
            return tokens[0].text;
        }

        return this.chooseTransactionAmountToken(line, tokens);
    }

    static extractAmountTokens(line) {
        return [...String(line || '').matchAll(this.amountTokenRegex())]
            .map(match => ({
                text: match[0].trim(),
                index: match.index || 0
            }))
            .filter(token => /\.\d{2}\)?\b/.test(token.text))
            .filter(token => !/^\d{1,2}:\d{2}$/.test(token.text));
    }

    static chooseTransactionAmountToken(line, tokens) {
        if (tokens.length === 0) return '';
        if (tokens.length === 1) return tokens[0].text;

        // Bank statement rows often end with a running balance. Use the amount
        // immediately before that balance instead of rejecting the whole row.
        if (this.looksLikeStatementAmountRow(line, tokens)) {
            return tokens[tokens.length - 2].text;
        }

        return tokens[0].text;
    }

    static looksLikeStatementAmountRow(line, tokens) {
        if (tokens.length < 2) return false;

        const lower = String(line || '').toLowerCase();
        const hasDate = this.dateTokenRegex().test(line);
        const hasStatementWords = /\b(balance|ending|opening|ledger|posted|available)\b/.test(lower);

        return hasDate || hasStatementWords || tokens.length >= 3;
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
            this.stripTransactionTokens(lines[index])
        );

        const previous = index > 0 ? this.cleanNameCandidate(this.stripTransactionTokens(lines[index - 1])) : '';
        const next = index + 1 < lines.length ? this.cleanNameCandidate(this.stripTransactionTokens(lines[index + 1])) : '';

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
        if (next && this.isLikelyBalanceMerchantLine(lines[index + 1] || '', next)) return next;
        if (next && !this.lineHasAmount(lines[index + 1] || '')) return next;
        return '';
    }

    static isLikelyBalanceCarryoverLine(lines, index, normalizedLine, dateRegex) {
        if (index <= 0 || !this.lineHasAmount(normalizedLine)) return false;

        const previousLine = this.normalizeText(lines[index - 1] || '');
        const previousDate = previousLine.match(dateRegex);
        if (!previousDate || !this.lineHasAmount(previousLine)) return false;

        const previousName = this.cleanNameCandidate(this.stripTransactionTokens(previousLine));
        if (this.isStrongMerchantName(previousName)) return false;

        const currentName = this.cleanNameCandidate(this.stripTransactionTokens(normalizedLine));
        return this.isLikelyBalanceMerchantLine(normalizedLine, currentName);
    }

    static isLikelyBalanceMerchantLine(line, merchantName) {
        if (!merchantName || !this.isStrongMerchantName(merchantName)) return false;

        const normalizedLine = this.normalizeText(line);
        if (this.dateTokenRegex().test(normalizedLine)) return false;

        const amountTokens = this.extractAmountTokens(normalizedLine);
        if (amountTokens.length !== 1) return false;

        const amountIndex = amountTokens[0].index;
        const beforeAmount = this.cleanNameCandidate(normalizedLine.slice(0, amountIndex));
        return amountIndex > 0 && this.isStrongMerchantName(beforeAmount);
    }

    static stripTransactionTokens(line) {
        return String(line || '')
            .replace(this.amountTokenRegex(), ' ')
            .replace(this.dateTokenRegex('g'), ' ');
    }

    static cleanNameCandidate(text) {
        const cleaned = (text || '')
            .replace(/[\u25A0-\u25FF\u2600-\u27BF]/g, ' ')
            .replace(/\b(pending|posted|complete|completed|debit|purchase|payment|online|transaction|card|tap|contactless|available|authorized)\b/gi, ' ')
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
        if (/\b(des|indn|id)\s*:/i.test(name)) return false;
        if (/\bxxxxx+\d*\b/i.test(name)) return false;
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

    static amountTokenRegex() {
        return /[+\-]?\$?\s*\(?\d{1,3}(?:,\d{3})*(?:[.]\d{2})\)?|[+\-]?\$?\s*\(?\d+(?:[.]\d{2})\)?/g;
    }

    static dateTokenRegex(flags = '') {
        return new RegExp(String.raw`\b(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|[A-Za-z]{3,9}\s\d{1,2}(?:,\s?\d{2,4})?)\b`, flags);
    }

    static shouldUsePdfOcr(textLines, transactions) {
        if (transactions.length === 0) return true;

        const datedCount = transactions.filter(tx => tx.date).length;
        if (datedCount / transactions.length < 0.6) return true;

        const tableSignals = this.countPdfTableSignals(textLines);

        return tableSignals >= 2;
    }

    static shouldPreferPdfOcr(textLines, textTransactions, ocrTransactions) {
        if (this.countPdfTableSignals(textLines) < 2 || ocrTransactions.length === 0) return false;
        if (textTransactions.length === 0) return true;

        const ocrDatedCount = ocrTransactions.filter(tx => tx.date).length;
        const hasEnoughRows = ocrTransactions.length >= Math.max(1, Math.floor(textTransactions.length * 0.6));
        const hasEnoughDates = ocrDatedCount >= Math.max(1, Math.floor(ocrTransactions.length * 0.6));

        return hasEnoughRows && hasEnoughDates;
    }

    static countPdfTableSignals(textLines) {
        return (textLines || []).filter(line => {
            const lower = String(line || '').toLowerCase();
            return lower.includes('balance') || this.extractAmountTokens(line).length >= 2;
        }).length;
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
            if (data[i + 3] === 0) {
                data[i] = 255;
                data[i + 1] = 255;
                data[i + 2] = 255;
                data[i + 3] = 255;
            }

            const grayscale = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            let nextValue = grayscale;

            if (options.mode === 'none') {
                nextValue = grayscale;
            } else if (options.mode === 'contrast') {
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
        const data = await this.runOcrDataOnCanvas(canvas, progressCallback);
        return data.text || '';
    }

    static async runOcrDataOnCanvas(canvas, progressCallback) {
        const result = await Tesseract.recognize(canvas, 'eng', {
            logger: message => {
                if (message.status === 'recognizing text' && progressCallback) {
                    progressCallback(Math.round(message.progress * 100));
                }
            }
        });

        return result.data || {};
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
