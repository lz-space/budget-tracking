class Scanner {
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

                if (!name) {
                    name = 'Unknown Vendor';
                }

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
            .replace(/\b(today|yesterday|details|view|merchant)\b/gi, ' ')
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
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    static async processImages(fileElement, statusCallback) {
        if (!fileElement.files || fileElement.files.length === 0) return [];

        statusCallback('Starting local OCR...');
        let allTransactions = [];

        for (let i = 0; i < fileElement.files.length; i += 1) {
            const file = fileElement.files[i];
            statusCallback(`Preparing image ${i + 1} of ${fileElement.files.length}...`);

            try {
                const url = URL.createObjectURL(file);
                const img = new Image();

                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = url;
                });

                const result = await Tesseract.recognize(img, 'eng', {
                    logger: message => {
                        if (message.status === 'recognizing text') {
                            statusCallback(`Scanning image ${i + 1}/${fileElement.files.length}... ${Math.round(message.progress * 100)}%`);
                        }
                    }
                });

                URL.revokeObjectURL(url);
                allTransactions = allTransactions.concat(this.parseText(result.data.text));
            } catch (error) {
                console.error(error);
                statusCallback(`Could not read image ${i + 1}.`);
            }
        }

        return this.dedupeTransactions(allTransactions);
    }
}

window.Scanner = Scanner;
