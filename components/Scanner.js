class Scanner {
    static MAX_IMAGE_DIMENSION = 1800;
    static lastOCRText = '';
    static lastError = '';

    static parseText(rawText) {
        const lines = rawText
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);

        const transactions = [];
        const amountRegex = /[+\-]?\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})/g;
        const dateRegex = /\b(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|[A-Za-z]{3,9}\s\d{1,2}(?:,\s?\d{2,4})?)\b/;

        let lastSeenDate = new Date().toISOString().split('T')[0];

        lines.forEach((line, index) => {
            const dateMatch = line.match(dateRegex);
            if (dateMatch) {
                const normalizedDate = this.normalizeDate(dateMatch[0]);
                if (normalizedDate) {
                    lastSeenDate = normalizedDate;
                }
            }

            const amountMatches = [...line.matchAll(amountRegex)];
            if (amountMatches.length === 0) return;

            amountMatches.forEach(match => {
                const amountToken = match[0];
                const amount = Math.abs(parseFloat(amountToken.replace(/[$,\s]/g, '')));
                if (!amount) return;

                let name = line
                    .replace(amountToken, ' ')
                    .replace(dateRegex, ' ')
                    .replace(/\b\d{2}:\d{2}\b/g, ' ')
                    .replace(/[|]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

                if (!name && index > 0 && !lines[index - 1].match(amountRegex)) {
                    name = lines[index - 1]
                        .replace(dateRegex, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                }

                name = this.cleanVendorName(name);
                if (!name) name = 'Unknown Vendor';

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

        return this.dedupeTransactions(transactions);
    }

    static cleanVendorName(name) {
        const cleaned = (name || '')
            .replace(/^[^A-Za-z0-9]+/g, ' ')
            .replace(/[\u25A0-\u25FF\u2600-\u27BF]/g, ' ')
            .replace(/\b(pending|posted|complete|completed)\b/gi, ' ')
            .replace(/\b(debit|credit|purchase|payment|online|transaction|card|tap|contactless|available)\b/gi, ' ')
            .replace(/\b(today|yesterday|details|view|merchant|statement|activity)\b/gi, ' ')
            .replace(/^[A-Z]\s+/g, ' ')
            .replace(/^[^A-Za-z0-9]+/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .replace(/^[-:•.*]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const tokens = cleaned.split(' ').filter(Boolean);
        const usefulTokens = tokens.filter(token => /[A-Za-z]/.test(token));
        const result = usefulTokens.length ? usefulTokens.join(' ') : cleaned;
        return result || 'Unknown Vendor';
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

    static dedupeTransactions(transactions) {
        const seen = new Set();
        return transactions.filter(tx => {
            const key = `${tx.date}|${tx.name.toLowerCase()}|${tx.amount.toFixed(2)}|${tx.type}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
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

        return this.dedupeTransactions(allTransactions);
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
        return (transactions.length * 1000) + normalizedText.length;
    }
}

window.Scanner = Scanner;
