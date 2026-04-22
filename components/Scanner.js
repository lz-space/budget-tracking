class Scanner {
    static MAX_IMAGE_DIMENSION = 1800;
    static lastOCRText = '';
    static lastError = '';
    static NON_TRANSACTION_TERMS = [
        'balance', 'available', 'account', 'statement', 'activity', 'ending',
        'routing', 'member fdic', 'search', 'filter', 'deposit account',
        'total', 'subtotal', 'summary', 'details', 'merchant', 'description',
        'transactions', 'transaction history', 'current balance', 'posted date'
    ];

    static parseText(rawText) {
        const lines = this.prepareLines(rawText);
        let transactions = this.extractTransactionsFromLines(lines);

        if (transactions.length === 0) {
            const normalizedLines = this.prepareLines(this.normalizeOCRText(rawText));
            transactions = this.extractTransactionsFromLines(normalizedLines);
        }

        return transactions;
    }

    static prepareLines(rawText) {
        return (rawText || '')
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);
    }

    static extractTransactionsFromLines(lines) {
        const transactions = [];
        const amountRegex = /[+\-]?\$?\s*\d[\d,\s]*(?:[.]\d{1,2})?/g;
        const dateRegex = /\b(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|[A-Za-z]{3,9}\s\d{1,2}(?:,\s?\d{2,4})?)\b/;
        const hasAnyDateHeader = lines.some(line => dateRegex.test(this.normalizeOCRText(line)));
        let lastSeenDate = new Date().toISOString().split('T')[0];
        let hasReachedTransactionSection = !hasAnyDateHeader;

        lines.forEach((line, index) => {
            const normalizedLine = this.normalizeOCRText(line);
            const dateMatch = normalizedLine.match(dateRegex);
            if (dateMatch) {
                const normalizedDate = this.normalizeDate(dateMatch[0]);
                if (normalizedDate) {
                    lastSeenDate = normalizedDate;
                    hasReachedTransactionSection = true;
                }
            }

            if (!hasReachedTransactionSection) return;

            const amountMatches = [...normalizedLine.matchAll(amountRegex)];
            if (amountMatches.length === 0) return;

            amountMatches.forEach(match => {
                const amountToken = match[0];
                if (!this.isLikelyAmountToken(amountToken)) return;
                const amount = Math.abs(this.parseAmount(amountToken));
                if (!amount || !this.isReasonableAmount(amount)) return;

                if (!this.isLikelyTransactionLine(normalizedLine, amountToken)) return;

                const contextLines = this.collectContextLines(lines, index);
                const merchantCandidate = this.extractMerchantName(contextLines, amountToken, dateRegex);
                if (!this.isLikelyMerchantName(merchantCandidate)) return;

                const name = merchantCandidate;
                const categorized = CategorizationEngine.categorize(name, CategorizationEngine.guessType(name, amountToken));

                transactions.push({
                    date: lastSeenDate,
                    name,
                    amount,
                    type: categorized.type,
                    category: categorized.c,
                    subCategory: categorized.s
                });
            });
        });

        return transactions;
    }

    static collectContextLines(lines, index) {
        const items = [];

        for (let offset = -1; offset <= 1; offset += 1) {
            const candidate = lines[index + offset];
            if (!candidate) continue;
            items.push({ text: candidate, offset });
        }

        return items;
    }

    static isLikelyTransactionLine(line, amountToken) {
        const lower = (line || '').toLowerCase();
        if (this.NON_TRANSACTION_TERMS.some(term => lower.includes(term))) {
            return false;
        }

        const alphaCount = (line.match(/[A-Za-z]/g) || []).length;
        const digitCount = (line.match(/\d/g) || []).length;
        const amountCount = [...line.matchAll(/[+\-]?\$?\s*\d[\d,\s]*(?:[.]\d{1,2})?/g)].length;

        if (amountCount > 2) return false;
        if (digitCount > 18 && alphaCount < 4) return false;
        if (String(amountToken || '').length < 4) return false;

        return true;
    }

    static extractMerchantName(contextLines, amountToken, dateRegex) {
        const candidates = [];

        contextLines.forEach(item => {
            const normalized = this.normalizeOCRText(item.text);
            const stripped = normalized
                .replace(new RegExp(this.escapeRegExp(amountToken), 'g'), ' ')
                .replace(dateRegex, ' ')
                .replace(/\b\d{2}:\d{2}\b/g, ' ')
                .replace(/[|]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            const cleaned = this.cleanVendorName(stripped);
            if (cleaned) {
                candidates.push({
                    text: cleaned,
                    score: this.scoreMerchantCandidate(cleaned, item.offset),
                    offset: item.offset
                });
            }
        });

        const currentCandidate = candidates.find(candidate => candidate.offset === 0);
        if (currentCandidate && this.isStrongCurrentLineCandidate(currentCandidate.text)) {
            return currentCandidate.text;
        }

        candidates.sort((left, right) => right.score - left.score);
        return candidates[0]?.text || '';
    }

    static scoreMerchantCandidate(name, offset) {
        const words = name.split(' ').filter(Boolean);
        const longWords = words.filter(word => word.length >= 4).length;
        const alphaCount = (name.match(/[A-Za-z]/g) || []).length;
        const junkPenalty = /\b(balance|account|ending|available|details|activity|statement|total|summary)\b/i.test(name) ? 18 : 0;
        const currentLineBonus = offset === 0 ? 18 : 0;
        const offsetPenalty = Math.abs(offset) * 18;

        return alphaCount + (longWords * 8) + currentLineBonus - junkPenalty - offsetPenalty;
    }

    static isStrongCurrentLineCandidate(name) {
        const words = name.split(' ').filter(Boolean);
        const alphaCount = (name.match(/[A-Za-z]/g) || []).length;
        return alphaCount >= 6 && words.length >= 1;
    }

    static isLikelyMerchantName(name) {
        if (!name) return false;

        const lower = name.toLowerCase();
        if (this.NON_TRANSACTION_TERMS.some(term => lower.includes(term))) {
            return false;
        }

        const words = name.split(' ').filter(Boolean);
        const alphaCount = (name.match(/[A-Za-z]/g) || []).length;
        const longWords = words.filter(word => word.length >= 3).length;

        if (alphaCount < 3) return false;
        if (longWords === 0) return false;
        if (/^\d+$/.test(name)) return false;

        return true;
    }

    static normalizeOCRText(rawText) {
        return (rawText || '')
            .replace(/[|]/g, ' ')
            .replace(/[Oo](?=\d{2}\b)/g, '0')
            .replace(/(?<=\d)[oO](?=\d)/g, '0')
            .replace(/[Ss](?=\d{2}\b)/g, '5')
            .replace(/[,](?=\d{2}\b)/g, '.')
            .replace(/\s{2,}/g, ' ');
    }

    static parseAmount(amountToken) {
        const normalized = String(amountToken)
            .replace(/[Oo]/g, '0')
            .replace(/[$,\s]/g, '')
            .replace(/[^0-9.+-]/g, '');

        const parsed = parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    static isLikelyAmountToken(amountToken) {
        const raw = String(amountToken || '').trim();
        if (!/\.\d{2}\b/.test(raw)) return false;
        if (/^\d{1,2}:\d{2}$/.test(raw)) return false;
        return true;
    }

    static cleanVendorName(name) {
        const cleaned = (name || '')
            .replace(/^[^A-Za-z0-9]+/g, ' ')
            .replace(/[\u25A0-\u25FF\u2600-\u27BF]/g, ' ')
            .replace(/\b(pending|posted|complete|completed)\b/gi, ' ')
            .replace(/\b(debit|credit|purchase|payment|online|transaction|card|tap|contactless|available|authorized)\b/gi, ' ')
            .replace(/\b(today|yesterday|details|view|merchant|statement|activity|balance|account|ending)\b/gi, ' ')
            .replace(/\b(total|subtotal|summary|transactions|history|search|filter)\b/gi, ' ')
            .replace(/\b\d{2}:\d{2}\b/g, ' ')
            .replace(/^[A-Z]\s+/g, ' ')
            .replace(/^[^A-Za-z0-9]+/g, ' ')
            .replace(/\b\d{4,}\b/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .replace(/^[-:•.*]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const tokens = cleaned.split(' ').filter(Boolean);
        const usefulTokens = tokens.filter(token => /[A-Za-z]/.test(token));
        const result = usefulTokens.length ? usefulTokens.join(' ') : cleaned;
        return result || '';
    }

    static normalizeDate(input) {
        const currentYear = new Date().getFullYear();
        let value = input.replace(/-/g, '/').trim();

        if (!/\d{4}/.test(value)) {
            value = value.includes('/') ? `${value}/${currentYear}` : `${value}, ${currentYear}`;
        }

        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return null;

        const month = String(parsed.getMonth() + 1).padStart(2, '0');
        const day = String(parsed.getDate()).padStart(2, '0');
        return `${parsed.getFullYear()}-${month}-${day}`;
    }

    static isReasonableAmount(amount) {
        return amount >= 0.01 && amount <= 50000;
    }

    static escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    static async processImages(fileElement, statusCallback) {
        if (!fileElement.files || fileElement.files.length === 0) return [];

        this.lastOCRText = '';
        this.lastError = '';
        statusCallback('Starting local OCR...');

        let allTransactions = [];

        for (let i = 0; i < fileElement.files.length; i += 1) {
            const file = fileElement.files[i];
            statusCallback(`Preparing image ${i + 1} of ${fileElement.files.length}...`);

            try {
                if (!this.isSupportedImage(file)) {
                    this.lastError = `Image ${i + 1} is not a supported image file.`;
                    statusCallback(`Image ${i + 1} is not a supported image file.`);
                    continue;
                }

                const image = await this.loadImage(file);
                const variants = this.prepareImageVariants(image);

                let bestText = '';
                let bestTransactions = [];

                for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
                    const variant = variants[variantIndex];
                    statusCallback(`Scanning image ${i + 1}/${fileElement.files.length} (${variant.label})...`);

                    const result = await Tesseract.recognize(variant.canvas, 'eng', {
                        logger: message => {
                            if (message.status === 'recognizing text') {
                                statusCallback(`Scanning image ${i + 1}/${fileElement.files.length} (${variant.label})... ${Math.round(message.progress * 100)}%`);
                            }
                        }
                    });

                    const text = result.data.text || '';
                    const transactions = this.parseText(text);

                    if (this.scoreOCRResult(text, transactions) > this.scoreOCRResult(bestText, bestTransactions)) {
                        bestText = text;
                        bestTransactions = transactions;
                    }

                    if (transactions.length > 0) {
                        break;
                    }
                }

                this.lastOCRText += `\n\n--- Image ${i + 1}: ${file.name || 'image'} ---\n${bestText}`;
                allTransactions = allTransactions.concat(bestTransactions);
            } catch (error) {
                console.error(error);
                this.lastError = `Could not read image ${i + 1}.`;
                statusCallback(`Could not read image ${i + 1}. Try a screenshot from your photo library or a clearer PNG/JPG.`);
            }
        }

        return allTransactions;
    }

    static isSupportedImage(file) {
        const type = (file.type || '').toLowerCase();
        if (type.startsWith('image/')) return true;

        const name = (file.name || '').toLowerCase();
        return ['.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif'].some(ext => name.endsWith(ext));
    }

    static async loadImage(file) {
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
        const targetWidth = Math.max(1, Math.round(width * scale));
        const targetHeight = Math.max(1, Math.round(height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, targetWidth, targetHeight);
        context.drawImage(image, 0, 0, targetWidth, targetHeight);

        const imageData = context.getImageData(0, 0, targetWidth, targetHeight);
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
        return canvas;
    }

    static scoreOCRResult(text, transactions) {
        const normalizedText = (text || '').trim();
        const namedTransactions = transactions.filter(transaction => transaction.name && transaction.name !== 'Unknown Vendor').length;
        return (transactions.length * 1000) + (namedTransactions * 250) + normalizedText.length;
    }
}

window.Scanner = Scanner;
