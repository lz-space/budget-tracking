class Scanner {
    static MAX_IMAGE_DIMENSION = 1800;
    static MAX_OCR_IMAGE_DIMENSION = 2600;
    static PDF_RENDER_SCALE = 3;
    static PDF_LOAD_TIMEOUT_MS = 15000;
    static PDF_OPEN_TIMEOUT_MS = 20000;
    static OCR_LOAD_TIMEOUT_MS = 15000;
    static TESSERACT_SOURCE = 'vendor/tesseract/tesseract.min.js';
    static TESSERACT_PATHS = {
        workerPath: 'vendor/tesseract/worker.min.js',
        corePath: 'vendor/tesseract/core',
        langPath: 'vendor/tesseract/lang'
    };
    static PDFJS_SOURCES = [
        {
            name: 'bundled PDF reader',
            type: 'script',
            lib: 'vendor/pdf.min.js',
            worker: 'vendor/pdf.worker.min.js'
        }
    ];
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
        let lastErrorMessage = '';

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
                lastErrorMessage = this.formatReadError(error);
                statusCallback(`Could not read file ${i + 1}. ${lastErrorMessage}`);
            }
        }

        if (allTransactions.length === 0 && lastErrorMessage) {
            return {
                error: lastErrorMessage
            };
        }

        return allTransactions;
    }

    static formatReadError(error) {
        const message = [error && error.name, error && error.message]
            .filter(Boolean)
            .join(': ') || String(error || '');

        if (/insecure|security/i.test(message)) {
            if (window.location && window.location.protocol === 'file:') {
                return 'This page is open as file://, so the browser blocks PDF and OCR scanning. Open http://127.0.0.1:8013/ instead.';
            }

            const localUrl = window.location && window.location.origin ? window.location.origin : 'the local app page';
            return `The browser blocked a reader security operation. Reload ${localUrl}/ and try again. Details: ${message}`;
        }

        return message || 'Try a clearer image or a text-based PDF.';
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
        statusCallback(`Loading OCR reader for image ${fileNumber}/${totalFiles}...`);
        await this.ensureTesseract(statusCallback);

        for (const variant of variants) {
            statusCallback(`Scanning image ${fileNumber}/${totalFiles} (${variant.label})...`);
            const ocrData = await this.runOcrDataOnCanvas(variant.canvas, message => {
                statusCallback(`Scanning image ${fileNumber}/${totalFiles} (${variant.label})... ${message}%`);
            });
            const dateContext = this.buildDateContextFromLines(this.extractOcrPositionedLines(ocrData).concat(this.prepareLines((ocrData && ocrData.text) || '')));
            const transactions = this.parseImageOcrDataWithState(ocrData, '', dateContext).transactions;
            const score = this.scoreParseResult(transactions);

            if (score > bestScore) {
                bestScore = score;
                bestTransactions = transactions;
            }

            if (variant.tableOptimized && transactions.length >= 8) {
                break;
            }
        }

        return bestTransactions;
    }

    static async processPdf(file, statusCallback, fileNumber, totalFiles) {
        statusCallback(`Preparing PDF ${fileNumber}/${totalFiles}...`);
        const pdfjsLib = await this.ensurePdfJs(statusCallback);
        statusCallback(`Opening PDF ${fileNumber}/${totalFiles}...`);
        const buffer = await file.arrayBuffer();
        const pdf = await this.getPdfDocument(pdfjsLib, buffer, statusCallback, fileNumber, totalFiles);
        let allTransactions = [];
        let activeDate = '';
        let pdfDateContext = null;
        let readableTextLineCount = 0;

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            statusCallback(`Reading PDF ${fileNumber}/${totalFiles}, page ${pageNumber}/${pdf.numPages}...`);
            const page = await pdf.getPage(pageNumber);

            const textLines = await this.extractPdfTextLines(page);
            readableTextLineCount += textLines.length;
            pdfDateContext = this.mergeDateContexts(pdfDateContext, this.buildDateContextFromLines(textLines, activeDate));
            let parsed = this.parseLinesWithState(textLines, activeDate, pdfDateContext);
            let transactions = parsed.transactions;
            activeDate = parsed.lastActiveDate;

            const positionedTextData = await this.extractPdfPositionedTextData(page);
            const positionedParsed = this.parsePdfOcrDataWithState(positionedTextData, activeDate, pdfDateContext);
            if (this.scoreParseResult(positionedParsed.transactions) > this.scoreParseResult(transactions)) {
                parsed = positionedParsed;
                transactions = parsed.transactions;
                activeDate = parsed.lastActiveDate;
            }

            if (this.shouldUsePdfOcr(textLines, transactions)) {
                parsed = await this.scanPdfPageWithOcrVariants(page, activeDate, pdfDateContext, statusCallback, fileNumber, totalFiles, pageNumber, pdf.numPages);
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

        if (allTransactions.length === 0) {
            throw new Error(readableTextLineCount > 0
                ? `PDF opened and ${readableTextLineCount} text lines were readable, but no transaction rows matched. Try exporting the account activity PDF/CSV instead of a statement summary, or upload a screenshot of the transaction table.`
                : 'PDF opened, but it did not contain readable text and OCR could not find transaction rows.');
        }

        return allTransactions;
    }

    static async ensurePdfJs(statusCallback) {
        if (window.pdfjsLib) {
            return window.pdfjsLib;
        }

        if (window.__spendletPdfJsPromise) {
            return window.__spendletPdfJsPromise;
        }

        window.__spendletPdfJsPromise = (async () => {
            let lastError = null;

            for (const source of this.PDFJS_SOURCES) {
                try {
                    if (statusCallback) {
                        statusCallback(`Loading PDF reader from ${source.name}...`);
                    }

                    const pdfjsLib = await this.withTimeout(
                        this.loadPdfJsSource(source),
                        this.PDF_LOAD_TIMEOUT_MS,
                        `PDF reader did not load from ${source.name}.`
                    );
                    pdfjsLib.GlobalWorkerOptions.workerSrc = source.worker;
                    window.pdfjsLib = pdfjsLib;
                    return pdfjsLib;
                } catch (error) {
                    lastError = error;
                    console.warn(`Could not load PDF.js from ${source.name}:`, error);
                }
            }

            throw new Error(`Could not load the PDF reader. Check your internet connection and try again.${lastError ? ` ${lastError.message}` : ''}`);
        })();

        try {
            return await window.__spendletPdfJsPromise;
        } catch (error) {
            window.__spendletPdfJsPromise = null;
            throw error;
        }
    }

    static async loadPdfJsSource(source) {
        if (source.type === 'script') {
            return this.loadPdfJsScript(source.lib);
        }

        return import(source.lib);
    }

    static loadPdfJsScript(src) {
        return new Promise((resolve, reject) => {
            if (window.pdfjsLib) {
                resolve(window.pdfjsLib);
                return;
            }

            this.loadScript(src, 'pdfjs').then(() => {
                if (window.pdfjsLib) {
                    resolve(window.pdfjsLib);
                } else {
                    reject(new Error(`PDF reader loaded from ${src}, but did not initialize.`));
                }
            }).catch(reject);
        });
    }

    static async getPdfDocument(pdfjsLib, buffer, statusCallback, fileNumber, totalFiles) {
        const loadPdf = options => pdfjsLib.getDocument({
            data: new Uint8Array(buffer.slice(0)),
            ...options
        }).promise;

        try {
            // Local file:// pages can stall when PDF.js tries to start a worker.
            return await this.withTimeout(
                loadPdf({ disableWorker: true }),
                this.PDF_OPEN_TIMEOUT_MS,
                'PDF reader timed out while opening the file.'
            );
        } catch (error) {
            console.warn('PDF reader failed, retrying once:', error);
            if (statusCallback) {
                statusCallback(`Retrying PDF ${fileNumber}/${totalFiles} without background worker...`);
            }
            return this.withTimeout(
                loadPdf({ disableWorker: true, stopAtErrors: false }),
                this.PDF_OPEN_TIMEOUT_MS,
                'PDF reader could not open this file.'
            );
        }
    }

    static withTimeout(promise, timeoutMs, message) {
        let timerId;
        const timeout = new Promise((_, reject) => {
            timerId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
        });

        return Promise.race([promise, timeout]).finally(() => {
            window.clearTimeout(timerId);
        });
    }

    static async ensureTesseract(statusCallback) {
        if (window.Tesseract) {
            return window.Tesseract;
        }

        if (window.__spendletTesseractPromise) {
            return window.__spendletTesseractPromise;
        }

        window.__spendletTesseractPromise = (async () => {
            if (statusCallback) {
                statusCallback('Loading OCR reader...');
            }

            await this.withTimeout(
                this.loadScript(this.TESSERACT_SOURCE, 'tesseract'),
                this.OCR_LOAD_TIMEOUT_MS,
                'OCR reader did not load from the bundled app files.'
            );

            if (!window.Tesseract) {
                throw new Error('OCR reader loaded, but did not initialize.');
            }

            return window.Tesseract;
        })();

        try {
            return await window.__spendletTesseractPromise;
        } catch (error) {
            window.__spendletTesseractPromise = null;
            throw error;
        }
    }

    static getTesseractOptions() {
        return {
            workerPath: new URL(this.TESSERACT_PATHS.workerPath, window.location.href).href,
            corePath: new URL(this.TESSERACT_PATHS.corePath, window.location.href).href,
            langPath: new URL(this.TESSERACT_PATHS.langPath, window.location.href).href,
            workerBlobURL: false,
            cacheMethod: 'none',
            gzip: true
        };
    }

    static loadScript(src, label) {
        return new Promise((resolve, reject) => {
            const selector = `script[data-spendlet-${label}="${src}"]`;
            const existing = document.querySelector(selector);
            if (existing) {
                if (existing.dataset.loaded === 'true') {
                    resolve();
                    return;
                }

                existing.addEventListener('load', () => resolve(), { once: true });
                existing.addEventListener('error', () => reject(new Error(`Could not load ${src}`)), { once: true });
                return;
            }

            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.dataset[`spendlet${label.charAt(0).toUpperCase()}${label.slice(1)}`] = src;
            script.onload = () => {
                script.dataset.loaded = 'true';
                resolve();
            };
            script.onerror = () => reject(new Error(`Could not load ${src}`));
            document.head.appendChild(script);
        });
    }

    static async scanPdfPageWithOcrVariants(page, activeDate, dateContext, statusCallback, fileNumber, totalFiles, pageNumber, pageCount) {
        statusCallback(`Loading OCR reader for PDF ${fileNumber}/${totalFiles}, page ${pageNumber}/${pageCount}...`);
        await this.ensureTesseract(statusCallback);
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
            const ocrDateContext = this.mergeDateContexts(
                dateContext,
                this.buildDateContextFromLines(this.extractOcrPositionedLines(ocrData).concat(this.prepareLines((ocrData && ocrData.text) || '')), activeDate)
            );
            const parsed = this.parsePdfOcrDataWithState(ocrData, activeDate, ocrDateContext);
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

    static async extractPdfPositionedTextData(page) {
        const textContent = await page.getTextContent();
        const words = [];
        const lines = [];

        textContent.items.forEach(item => {
            const rawText = this.normalizeText(item.str || '');
            if (!rawText) return;

            const transform = item.transform || [];
            const x = Number(transform[4]);
            const y = -Number(transform[5]);
            const itemWidth = Math.max(1, Number(item.width) || rawText.length * 7);
            const itemHeight = Math.max(8, Number(item.height) || Math.abs(Number(transform[3])) || 12);

            if (!Number.isFinite(x) || !Number.isFinite(y)) return;

            lines.push(rawText);

            const tokens = rawText.match(/\S+/g) || [];
            if (tokens.length === 0) return;

            let charCursor = 0;
            tokens.forEach(token => {
                const tokenIndex = rawText.indexOf(token, charCursor);
                const tokenStart = tokenIndex === -1 ? charCursor : tokenIndex;
                const tokenEnd = tokenStart + token.length;
                const x0 = x + (tokenStart / rawText.length) * itemWidth;
                const x1 = x + (tokenEnd / rawText.length) * itemWidth;
                charCursor = tokenEnd;

                words.push({
                    text: token,
                    bbox: {
                        x0,
                        x1,
                        y0: y,
                        y1: y + itemHeight
                    }
                });
            });
        });

        return {
            text: lines.join('\n'),
            words
        };
    }

    static parseText(rawText) {
        return this.parseTextWithState(rawText, '').transactions;
    }

    static parseLines(lines) {
        return this.parseLinesWithState(lines, '').transactions;
    }

    static parseTextWithState(rawText, initialDate = '', dateContext = null) {
        const lines = this.prepareLines(rawText);
        const resolvedDateContext = this.mergeDateContexts(dateContext, this.buildDateContextFromLines(lines, initialDate));
        const tableParsed = this.parseTransactionTableLinesWithState(lines, initialDate, resolvedDateContext);
        const standardParsed = this.parseLinesWithState(lines, initialDate, resolvedDateContext);

        return this.scoreParseResult(tableParsed.transactions) > this.scoreParseResult(standardParsed.transactions)
            ? tableParsed
            : standardParsed;
    }

    static parseImageOcrDataWithState(ocrData, initialDate = '', dateContext = null) {
        const resolvedDateContext = this.mergeDateContexts(
            dateContext,
            this.buildDateContextFromLines(this.extractOcrPositionedLines(ocrData).concat(this.prepareLines((ocrData && ocrData.text) || '')), initialDate)
        );
        const mobileParsed = this.parsePositionedMobileTransactionListWithState(ocrData, initialDate, resolvedDateContext);
        const positionedTable = this.parsePositionedTransactionTableWithState(ocrData, initialDate, resolvedDateContext);
        const textParsed = this.parseTextWithState((ocrData && ocrData.text) || '', initialDate, resolvedDateContext);

        if (
            mobileParsed.transactions.length > 0 &&
            this.scoreParseResult(mobileParsed.transactions) >= Math.max(
                this.scoreParseResult(positionedTable.transactions),
                this.scoreParseResult(textParsed.transactions)
            )
        ) {
            return mobileParsed;
        }

        if (positionedTable.isTable && positionedTable.transactions.length > 0) {
            return positionedTable;
        }

        return this.scoreParseResult(positionedTable.transactions) >= this.scoreParseResult(textParsed.transactions)
            ? positionedTable
            : textParsed;
    }

    static parsePdfOcrDataWithState(ocrData, initialDate = '', dateContext = null) {
        const resolvedDateContext = this.mergeDateContexts(
            dateContext,
            this.buildDateContextFromLines(this.extractOcrPositionedLines(ocrData).concat(this.prepareLines((ocrData && ocrData.text) || '')), initialDate)
        );
        const mobileParsed = this.parsePositionedMobileTransactionListWithState(ocrData, initialDate, resolvedDateContext);
        const positionedTable = this.parsePositionedTransactionTableWithState(ocrData, initialDate, resolvedDateContext);

        if (
            mobileParsed.transactions.length > 0 &&
            this.scoreParseResult(mobileParsed.transactions) >= this.scoreParseResult(positionedTable.transactions)
        ) {
            return mobileParsed;
        }

        if (positionedTable.transactions.length > 0) {
            return positionedTable;
        }

        const positionedLines = this.extractOcrPositionedLines(ocrData);
        if (positionedLines.length > 0) {
            const tableParsed = this.parseTransactionTableLinesWithState(positionedLines, initialDate, resolvedDateContext);
            if (tableParsed.transactions.length > 0) {
                return tableParsed;
            }

            const parsed = this.parseLinesWithState(positionedLines, initialDate, resolvedDateContext);
            if (parsed.transactions.length > 0) {
                return parsed;
            }
        }

        const textParsed = this.parseTextWithState((ocrData && ocrData.text) || '', initialDate, resolvedDateContext);
        return this.scoreParseResult(mobileParsed.transactions) >= this.scoreParseResult(textParsed.transactions)
            ? mobileParsed
            : textParsed;
    }

    static parsePositionedMobileTransactionListWithState(ocrData, initialDate = '', dateContext = null) {
        const words = this.extractPositionedWords(ocrData);
        if (words.length === 0) {
            return { transactions: [], lastActiveDate: initialDate || '', isMobileList: false };
        }

        const rows = this.groupWordsIntoRows(words);
        const moneyWords = this.extractMoneyWords(words);
        if (rows.length === 0 || moneyWords.length === 0) {
            return { transactions: [], lastActiveDate: initialDate || '', isMobileList: false };
        }
        if (this.hasTableHeaderSignals(rows)) {
            return { transactions: [], lastActiveDate: initialDate || '', isMobileList: false };
        }

        const maxX = Math.max(...words.map(word => word.x1));
        const mobileAmountWords = moneyWords
            .filter(word => this.isMobileRightSideAmount(word, maxX))
            .sort((left, right) => left.y - right.y);

        if (mobileAmountWords.length === 0) {
            return { transactions: [], lastActiveDate: initialDate || '', isMobileList: false };
        }

        const candidates = [];
        const dateRegex = this.dateTokenRegex();
        const typicalGap = this.estimateTypicalVerticalGap(mobileAmountWords);

        mobileAmountWords.forEach((amountWord, index) => {
            const previous = mobileAmountWords[index - 1];
            const next = mobileAmountWords[index + 1];
            const top = previous ? (previous.y + amountWord.y) / 2 : amountWord.y - Math.max(130, typicalGap * 0.7);
            const bottom = next ? (amountWord.y + next.y) / 2 : amountWord.y + Math.max(150, typicalGap * 0.65);
            const blockRows = rows.filter(row => row.y >= top && row.y < bottom);
            if (blockRows.length === 0) return;

            const usableRows = blockRows.filter(row => !this.isMobileListUiLine(row.text));
            const nameRows = usableRows.filter(row => !this.isMobileMetadataLine(row.text, dateRegex));
            const blockWords = usableRows.flatMap(row => row.words);
            if (blockWords.length === 0) return;

            const amount = this.parseAmount(amountWord.text);
            if (!this.isReasonableAmount(amount)) return;

            const dateMatch = this.normalizeText(blockRows.map(row => row.text).join(' ')).match(dateRegex);
            const lineDate = dateMatch ? this.normalizeDate(dateMatch[0], dateContext) : initialDate;
            const balanceWord = this.chooseMobileBalanceWord(blockWords, amountWord, maxX);
            const name = this.cleanNameCandidate(
                nameRows
                    .flatMap(row => row.words)
                    .filter(word => {
                        return word.x0 < amountWord.x0 - 6 &&
                            !this.isSamePositionedWord(word, amountWord) &&
                            !dateRegex.test(word.text) &&
                            !this.isStatusDatePlaceholder(word.text) &&
                            !this.isRowActionNoise(word.text) &&
                            !this.extractAmountTokens(word.text).length;
                    })
                    .map(word => word.text)
                    .join(' ')
            );
            if (!this.isLikelyMerchantName(name)) return;

            const amountText = this.getMobileSignedAmountText(blockWords, amountWord);
            candidates.push({
                date: lineDate || '',
                name,
                amount,
                amountText,
                balanceAfter: balanceWord ? this.parseSignedAmount(balanceWord.text) : null,
                balanceText: balanceWord ? balanceWord.text : '',
                moneyCandidates: this.extractMoneyWords(blockWords).map(word => ({
                    text: word.text,
                    amount: this.parseAmount(word.text),
                    isBalanceCandidate: balanceWord ? this.isSamePositionedWord(word, balanceWord) : false
                })),
                typeHint: CategorizationEngine.guessType(name, amountText)
            });
        });

        const transactions = candidates.map(candidate => this.buildTransactionFromCandidate(candidate));
        const lastDated = [...transactions].reverse().find(transaction => transaction.date);

        return {
            transactions,
            lastActiveDate: lastDated ? lastDated.date : initialDate || '',
            isMobileList: transactions.length > 0
        };
    }

    static isMobileRightSideAmount(word, maxX) {
        const amount = this.parseAmount(word.text);
        if (!this.isReasonableAmount(amount)) return false;
        return this.wordCenterX(word) >= maxX * 0.52;
    }

    static hasTableHeaderSignals(rows) {
        return rows.some(row => {
            const lower = String(row.text || '').toLowerCase();
            return /\b(amount|balance)\b/.test(lower) && /\b(date|description|posting|type)\b/.test(lower);
        });
    }

    static estimateTypicalVerticalGap(words) {
        const sorted = [...words].sort((left, right) => left.y - right.y);
        const gaps = [];

        for (let index = 1; index < sorted.length; index += 1) {
            const gap = sorted[index].y - sorted[index - 1].y;
            if (gap > 20) gaps.push(gap);
        }

        if (gaps.length === 0) return 180;
        gaps.sort((a, b) => a - b);
        return gaps[Math.floor(gaps.length / 2)];
    }

    static isMobileListUiLine(line) {
        const lower = String(line || '').toLowerCase();
        return /\b(total checking|manage account|see all transactions|see statements|checking benefits|pay transfer more)\b/.test(lower);
    }

    static isMobileMetadataLine(line, dateRegex) {
        const normalizedLine = this.normalizeText(line);
        if (!normalizedLine) return true;
        if (/^(pending|posted|-+)$/.test(normalizedLine.toLowerCase())) return true;
        if (/^id[:#]?\b/i.test(normalizedLine)) return true;
        if (this.extractAmountTokens(normalizedLine).length && !this.cleanNameCandidate(this.stripTransactionTokens(normalizedLine))) return true;

        const withoutDate = normalizedLine.replace(dateRegex, ' ').replace(/\s+/g, ' ').trim();
        if (!withoutDate || withoutDate === ',') return true;
        return false;
    }

    static chooseMobileBalanceWord(blockWords, amountWord, maxX) {
        const balances = this.extractMoneyWords(blockWords)
            .filter(word => !this.isSamePositionedWord(word, amountWord))
            .filter(word => this.wordCenterX(word) < maxX * 0.52)
            .filter(word => word.y >= amountWord.y - 8)
            .sort((left, right) => Math.abs(left.y - amountWord.y) - Math.abs(right.y - amountWord.y));

        return balances[0] || null;
    }

    static getMobileSignedAmountText(blockWords, amountWord) {
        const signWord = blockWords.find(word => {
            if (Math.abs(word.y - amountWord.y) > Math.max(10, amountWord.height)) return false;
            if (word.x1 > amountWord.x0 + 3 || word.x0 < amountWord.x0 - 40) return false;
            return /^[-+]$/.test(word.text) || /^[-+]?\$$/.test(word.text);
        });

        if (!signWord || /^[+$]$/.test(signWord.text)) return amountWord.text;
        return `${signWord.text.replace('$', '')}${amountWord.text}`;
    }

    static isSamePositionedWord(left, right) {
        if (!left || !right) return false;
        return left.text === right.text &&
            Math.abs(left.x0 - right.x0) <= 1 &&
            Math.abs(left.x1 - right.x1) <= 1 &&
            Math.abs(left.y - right.y) <= 1;
    }

    static parseTransactionTableLinesWithState(lines, initialDate = '', dateContext = null) {
        const candidates = [];
        const dateRegex = this.dateTokenRegex();
        let activeDate = initialDate || '';
        const resolvedDateContext = this.mergeDateContexts(dateContext, this.buildDateContextFromLines(lines, initialDate));

        lines.forEach(line => {
            const normalizedLine = this.normalizeText(line);
            if (!this.looksLikeTransactionTableLine(normalizedLine)) return;

            const dateMatch = normalizedLine.match(dateRegex);
            const lineDate = dateMatch ? this.normalizeDate(dateMatch[0], resolvedDateContext) : activeDate;
            if (dateMatch && lineDate) activeDate = lineDate;

            const amountTokens = this.extractAmountTokens(normalizedLine);
            if (amountTokens.length === 0) return;

            const amountToken = this.chooseTableTransactionAmountToken(normalizedLine, amountTokens);
            const amount = this.parseAmount(amountToken);
            if (!this.isReasonableAmount(amount)) return;
            const balanceToken = this.getTrailingBalanceToken(amountTokens);
            const balanceAfter = balanceToken ? this.parseSignedAmount(balanceToken.text) : null;

            const name = this.cleanNameCandidate(
                normalizedLine
                    .slice(0, amountTokens[0].index)
                    .replace(dateRegex, ' ')
                    .replace(/\b(type|amount|balance|description|posting date)\b/gi, ' ')
            );
            if (!this.isLikelyMerchantName(name)) return;

            candidates.push({
                date: lineDate,
                name,
                amount,
                amountText: amountToken,
                balanceAfter,
                balanceText: balanceToken ? balanceToken.text : '',
                moneyCandidates: amountTokens.map(token => ({
                    text: token.text,
                    amount: this.parseAmount(token.text),
                    isBalanceCandidate: balanceToken ? token.index === balanceToken.index && token.text === balanceToken.text : false
                })),
                typeHint: CategorizationEngine.guessType(name, amountToken)
            });
        });

        return {
            transactions: this.reconcileRunningBalanceCandidates(candidates).map(candidate => this.buildTransactionFromCandidate(candidate)),
            lastActiveDate: activeDate
        };
    }

    static parsePositionedTransactionTableWithState(ocrData, initialDate = '', dateContext = null) {
        const positionedWords = this.extractPositionedWords(ocrData);
        const rows = this.extractOcrRows(ocrData);
        if (rows.length === 0) {
            return { transactions: [], lastActiveDate: initialDate || '', isTable: false };
        }
        const resolvedDateContext = this.mergeDateContexts(dateContext, this.buildDateContextFromLines(rows.map(row => row.text), initialDate));

        const allRows = this.groupWordsIntoRows(positionedWords);
        const columnHints = this.detectTransactionTableColumns(allRows.length > rows.length ? allRows : rows);
        if (!columnHints) {
            return { transactions: [], lastActiveDate: initialDate || '', isTable: false };
        }

        const candidates = [];
        const dateRegex = this.dateTokenRegex();
        let activeDate = initialDate || '';

        rows.forEach(row => {
            const line = this.normalizeText(row.text);
            if (!line || this.isTableHeaderOrSummaryLine(line)) return;

            const dateMatch = this.getPositionedTableDateMatch(row, columnHints);
            const hasStatusAnchor = this.hasPositionedStatusAnchor(row, columnHints);
            if (!dateMatch && !hasStatusAnchor) return;

            const lineDate = dateMatch ? this.normalizeDate(dateMatch[0], resolvedDateContext) : '';
            if (dateMatch && !lineDate) return;
            if (lineDate) activeDate = lineDate;

            const moneyWords = this.extractMoneyWords(row.words);
            if (moneyWords.length === 0) return;

            const amountWord = this.choosePositionedAmountWord(moneyWords, columnHints);
            if (!amountWord) return;
            const balanceWord = this.choosePositionedBalanceWord(moneyWords, columnHints);

            const amount = this.parseAmount(amountWord.text);
            if (!this.isReasonableAmount(amount)) return;

            const nameWords = row.words.filter(word => {
                const center = this.wordCenterX(word);
                return center > columnHints.descriptionStartX &&
                    center < Math.min(amountWord.x0 - 4, columnHints.descriptionEndX) &&
                    !dateRegex.test(word.text) &&
                    !this.isStatusDatePlaceholder(word.text) &&
                    !this.isRowActionNoise(word.text) &&
                    !this.extractAmountTokens(word.text).length;
            });

            const name = this.cleanNameCandidate(nameWords.map(word => word.text).join(' '));
            if (!this.isLikelyMerchantName(name)) return;

            const inferredType = this.guessTypeFromPositionedTableRow(row, amountWord, name, columnHints);
            candidates.push({
                date: lineDate,
                name,
                amount,
                amountText: amountWord.text,
                balanceAfter: balanceWord ? this.parseSignedAmount(balanceWord.text) : null,
                balanceText: balanceWord ? balanceWord.text : '',
                moneyCandidates: moneyWords.map(word => ({
                    text: word.text,
                    amount: this.parseAmount(word.text),
                    isBalanceCandidate: balanceWord ? word === balanceWord : false
                })),
                typeHint: inferredType
            });
        });

        return {
            transactions: this.reconcileRunningBalanceCandidates(candidates).map(candidate => this.buildTransactionFromCandidate(candidate)),
            lastActiveDate: activeDate,
            isTable: true
        };
    }

    static buildTransactionFromCandidate(candidate) {
        const name = this.refineMerchantName(candidate.name);
        const preferredType = candidate.typeHint || CategorizationEngine.guessType(name, candidate.amountText);
        const categorized = CategorizationEngine.categorize(name, preferredType);
        const transaction = {
            date: candidate.date,
            name,
            amount: candidate.amount,
            type: categorized.type,
            category: categorized.c,
            subCategory: categorized.s
        };

        if (Number.isFinite(candidate.balanceAfter)) {
            transaction.scanBalanceAfter = this.roundMoney(candidate.balanceAfter);
        }
        if (candidate.scanBalanceMatched) {
            transaction.scanBalanceMatched = true;
        }
        if (candidate.scanWarning) {
            transaction.scanWarning = candidate.scanWarning;
        }

        return transaction;
    }

    static reconcileRunningBalanceCandidates(candidates) {
        const reconciled = candidates.map(candidate => ({
            ...candidate,
            moneyCandidates: (candidate.moneyCandidates || []).filter(item => this.isReasonableAmount(item.amount))
        }));

        if (reconciled.filter(candidate => Number.isFinite(candidate.balanceAfter)).length < 2) {
            return reconciled;
        }

        const order = this.detectRunningBalanceOrder(reconciled);
        for (let index = 0; index < reconciled.length - 1; index += 1) {
            const current = reconciled[index];
            const next = reconciled[index + 1];
            if (!Number.isFinite(current.balanceAfter) || !Number.isFinite(next.balanceAfter)) continue;

            const targetIndex = order === 'oldest-first' ? index + 1 : index;
            const target = reconciled[targetIndex];
            const signedDifference = order === 'oldest-first'
                ? next.balanceAfter - current.balanceAfter
                : current.balanceAfter - next.balanceAfter;
            const expectedAmount = this.roundMoney(Math.abs(signedDifference));
            if (!this.isReasonableAmount(expectedAmount)) continue;

            const matchingMoney = this.findMoneyCandidateMatchingAmount(target, expectedAmount);
            if (matchingMoney) {
                target.amount = matchingMoney.amount;
                target.amountText = matchingMoney.text;
                target.scanBalanceMatched = true;
                target.scanWarning = '';
                continue;
            }

            if (!this.amountsClose(target.amount, expectedAmount) && target.moneyCandidates.length >= 2) {
                target.scanWarning = `Running balance changes by ${this.formatMoney(expectedAmount)}, but OCR read ${this.formatMoney(target.amount)}. Please review this amount.`;
            }
        }

        return reconciled;
    }

    static detectRunningBalanceOrder(candidates) {
        const newestFirstScore = this.scoreRunningBalanceOrder(candidates, 'newest-first');
        const oldestFirstScore = this.scoreRunningBalanceOrder(candidates, 'oldest-first');

        if (newestFirstScore >= oldestFirstScore + 2) return 'newest-first';
        if (oldestFirstScore >= newestFirstScore + 2) return 'oldest-first';

        const dateOrder = this.detectDateOrder(candidates);
        if (dateOrder === 'ascending') return 'oldest-first';
        if (dateOrder === 'descending') return 'newest-first';

        return newestFirstScore >= oldestFirstScore ? 'newest-first' : 'oldest-first';
    }

    static scoreRunningBalanceOrder(candidates, order) {
        let score = 0;

        for (let index = 0; index < candidates.length - 1; index += 1) {
            const current = candidates[index];
            const next = candidates[index + 1];
            if (!Number.isFinite(current.balanceAfter) || !Number.isFinite(next.balanceAfter)) continue;

            const target = order === 'oldest-first' ? next : current;
            const signedDifference = order === 'oldest-first'
                ? next.balanceAfter - current.balanceAfter
                : current.balanceAfter - next.balanceAfter;
            const expectedAmount = this.roundMoney(Math.abs(signedDifference));
            if (!this.isReasonableAmount(expectedAmount)) continue;

            if (this.amountsClose(target.amount, expectedAmount)) score += 1;
            if (this.findMoneyCandidateMatchingAmount(target, expectedAmount)) score += 3;
        }

        return score;
    }

    static detectDateOrder(candidates) {
        const dated = candidates
            .map(candidate => Date.parse(candidate.date))
            .filter(time => Number.isFinite(time));
        if (dated.length < 2) return '';

        let ascending = 0;
        let descending = 0;
        for (let index = 1; index < dated.length; index += 1) {
            if (dated[index] > dated[index - 1]) ascending += 1;
            if (dated[index] < dated[index - 1]) descending += 1;
        }

        if (ascending > descending) return 'ascending';
        if (descending > ascending) return 'descending';
        return '';
    }

    static findMoneyCandidateMatchingAmount(candidate, expectedAmount) {
        const moneyCandidates = candidate.moneyCandidates || [];
        return moneyCandidates.find(item => !item.isBalanceCandidate && this.amountsClose(item.amount, expectedAmount)) || null;
    }

    static amountsClose(left, right) {
        return Math.abs(this.roundMoney(left) - this.roundMoney(right)) <= 0.01;
    }

    static roundMoney(value) {
        return Math.round((Number(value) || 0) * 100) / 100;
    }

    static formatMoney(value) {
        const rounded = this.roundMoney(value);
        return `${rounded < 0 ? '-' : ''}$${Math.abs(rounded).toFixed(2)}`;
    }

    static extractOcrRows(ocrData) {
        const words = this.extractPositionedWords(ocrData);
        if (words.length === 0) return [];

        const anchoredRows = this.extractTableAnchoredRows(words);
        if (anchoredRows.length >= 3) {
            return anchoredRows;
        }

        return this.groupWordsIntoRows(words);
    }

    static extractTableAnchoredRows(words) {
        const maxX = Math.max(...words.map(word => word.x1));
        const leftDateLimit = maxX * 0.32;
        const rowAnchors = [];

        words
            .filter(word => this.isTableRowAnchorWord(word, leftDateLimit))
            .sort((a, b) => a.y - b.y || a.x0 - b.x0)
            .forEach(word => {
                const existing = rowAnchors.find(anchor => Math.abs(anchor.y - word.y) <= Math.max(8, word.height * 0.7));
                if (existing) {
                    if (word.x0 < existing.x0) {
                        existing.x0 = word.x0;
                        existing.y = word.y;
                    }
                } else {
                    rowAnchors.push({ y: word.y, x0: word.x0 });
                }
            });

        if (rowAnchors.length < 3) return [];

        return rowAnchors.map((anchor, index) => {
            const previous = rowAnchors[index - 1];
            const next = rowAnchors[index + 1];
            const top = previous ? (previous.y + anchor.y) / 2 : anchor.y - this.estimateRowHalfHeight(rowAnchors, index);
            const bottom = next ? (anchor.y + next.y) / 2 : anchor.y + this.estimateRowHalfHeight(rowAnchors, index);
            const rowWords = words.filter(word => word.y >= top && word.y < bottom);

            return this.buildOcrRow(anchor.y, rowWords);
        }).filter(row => row.text && this.hasTableRowAnchor(row.text));
    }

    static isTableRowAnchorWord(word, leftLimit) {
        if (word.x0 > leftLimit) return false;
        return this.dateTokenRegex().test(word.text) || this.isStatusDatePlaceholder(word.text);
    }

    static hasTableRowAnchor(text) {
        return this.dateTokenRegex().test(text) || this.hasStatusDatePlaceholder(text);
    }

    static hasStatusDatePlaceholder(text) {
        return String(text || '').split(/\s+/).some(word => this.isStatusDatePlaceholder(word));
    }

    static isStatusDatePlaceholder(text) {
        return /^(processing|pending)$/i.test(this.normalizeText(text));
    }

    static isRowActionNoise(text) {
        return /^(view\/?edit|edit|view)$/i.test(this.normalizeText(text));
    }

    static getPositionedTableDateMatch(row, columnHints) {
        const dateRegex = this.dateTokenRegex();
        const dateWord = row.words.find(word => word.x0 < columnHints.descriptionStartX && dateRegex.test(word.text));
        return dateWord ? dateWord.text.match(dateRegex) : null;
    }

    static hasPositionedStatusAnchor(row, columnHints) {
        return row.words.some(word => word.x0 < columnHints.descriptionStartX && this.isStatusDatePlaceholder(word.text));
    }

    static estimateRowHalfHeight(anchors, index) {
        const gaps = [];
        if (anchors[index - 1]) gaps.push(Math.abs(anchors[index].y - anchors[index - 1].y));
        if (anchors[index + 1]) gaps.push(Math.abs(anchors[index + 1].y - anchors[index].y));

        const gap = gaps.length ? Math.min(...gaps) : 24;
        return Math.max(10, gap / 2);
    }

    static groupWordsIntoRows(words) {
        const averageHeight = words.reduce((sum, word) => sum + word.height, 0) / words.length;
        const rowTolerance = Math.max(8, averageHeight * 0.6);
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
            .map(row => this.buildOcrRow(row.y, row.words))
            .filter(row => row.text);
    }

    static buildOcrRow(y, words) {
        const sortedWords = words.sort((a, b) => a.x0 - b.x0);
        return {
            y,
            words: sortedWords,
            text: this.normalizeText(sortedWords.map(word => word.text).join(' '))
        };
    }

    static extractPositionedWords(ocrData) {
        return ((ocrData && ocrData.words) || [])
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
            .filter(word => word.text && Number.isFinite(word.x0) && Number.isFinite(word.x1) && Number.isFinite(word.y));
    }

    static detectTransactionTableColumns(rows) {
        const allWords = rows.flatMap(row => row.words);
        if (allWords.length === 0) return null;

        const maxX = Math.max(...allWords.map(word => word.x1));
        const headerWords = allWords.filter(word => /^(posting|date|description|type|amount|balance)$/i.test(word.text));
        const amountHeader = headerWords.find(word => /^amount$/i.test(word.text));
        const balanceHeader = headerWords.find(word => /^balance$/i.test(word.text));
        const descriptionHeader = headerWords.find(word => /^description$/i.test(word.text));
        const typeHeader = headerWords.find(word => /^type$/i.test(word.text));

        const amountX = amountHeader ? this.wordCenterX(amountHeader) : maxX * 0.82;
        const balanceX = balanceHeader ? this.wordCenterX(balanceHeader) : maxX * 0.94;
        const descriptionStartX = descriptionHeader ? Math.max(0, descriptionHeader.x0 - 10) : maxX * 0.16;
        const descriptionEndX = typeHeader ? Math.max(descriptionStartX + 20, typeHeader.x0 - 8) : amountX - 60;

        const hasHeader = Boolean(amountHeader && (balanceHeader || descriptionHeader));
        const hasTableRows = rows.some(row => this.dateTokenRegex().test(row.text) && this.extractMoneyWords(row.words).length >= 1);

        if (!hasHeader && !hasTableRows) return null;

        return {
            amountX,
            balanceX,
            descriptionStartX,
            descriptionEndX,
            typeStartX: typeHeader ? typeHeader.x0 - 10 : descriptionEndX,
            typeEndX: amountX - 20
        };
    }

    static guessTypeFromPositionedTableRow(row, amountWord, name, columnHints) {
        const typeText = row.words
            .filter(word => {
                const center = this.wordCenterX(word);
                return center >= columnHints.typeStartX &&
                    center <= columnHints.typeEndX &&
                    word.x1 < amountWord.x0 - 4 &&
                    !this.isRowActionNoise(word.text);
            })
            .map(word => word.text)
            .join(' ')
            .toLowerCase();

        if (/\b(credit|deposit|income|refund)\b/.test(typeText)) return 'income';
        if (/\b(debit|charge|withdrawal|purchase|payment|fee)\b/.test(typeText)) return 'expense';

        return CategorizationEngine.guessType(name, amountWord.text);
    }

    static extractMoneyWords(words) {
        return words
            .map(word => {
                const tokens = this.extractAmountTokens(word.text);
                if (tokens.length === 0) return null;
                return {
                    ...word,
                    text: tokens[tokens.length - 1].text
                };
            })
            .filter(Boolean);
    }

    static choosePositionedAmountWord(moneyWords, columnHints) {
        if (moneyWords.length === 0) return null;
        if (moneyWords.length === 1) return moneyWords[0];

        const scored = moneyWords.map(word => {
            const center = this.wordCenterX(word);
            const amountDistance = Math.abs(center - columnHints.amountX);
            const balanceDistance = Math.abs(center - columnHints.balanceX);
            const balancePenalty = balanceDistance < amountDistance ? 2000 : 0;

            return {
                word,
                score: amountDistance + balancePenalty
            };
        });

        scored.sort((a, b) => a.score - b.score);
        return scored[0].word;
    }

    static choosePositionedBalanceWord(moneyWords, columnHints) {
        if (moneyWords.length < 2) return null;

        const scored = moneyWords.map(word => {
            const center = this.wordCenterX(word);
            return {
                word,
                score: Math.abs(center - columnHints.balanceX) - (center > columnHints.amountX ? 20 : 0)
            };
        });

        scored.sort((a, b) => a.score - b.score);
        return scored[0].word;
    }

    static wordCenterX(word) {
        return (Number(word.x0) + Number(word.x1)) / 2;
    }

    static isTableHeaderOrSummaryLine(line) {
        const lower = String(line || '').toLowerCase();
        return /\b(posting date|description|amount|balance|total|payments and other credits|purchases and adjustments|interest charged)\b/.test(lower);
    }

    static extractOcrPositionedLines(ocrData) {
        return this.extractOcrRows(ocrData).map(row => row.text);
    }

    static parseLinesWithState(lines, initialDate = '', dateContext = null) {
        const transactions = [];
        const dateRegex = this.dateTokenRegex();
        let activeDate = initialDate || '';
        const resolvedDateContext = this.mergeDateContexts(dateContext, this.buildDateContextFromLines(lines, initialDate));

        lines.forEach((line, index) => {
            const normalizedLine = this.normalizeText(line);
            const dateMatch = normalizedLine.match(dateRegex);
            let lineDate = '';

            if (dateMatch) {
                lineDate = this.normalizeDate(dateMatch[0], resolvedDateContext);
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

            const name = this.refineMerchantName(this.extractTransactionName(lines, index, amountMatch, dateRegex));
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

    static looksLikeTransactionTableLine(line) {
        const normalizedLine = this.normalizeText(line);
        const hasDate = this.dateTokenRegex().test(normalizedLine);
        const amountTokens = this.extractAmountTokens(normalizedLine);
        const merchantName = this.cleanNameCandidate(
            normalizedLine
                .slice(0, amountTokens[0] ? amountTokens[0].index : normalizedLine.length)
                .replace(this.dateTokenRegex(), ' ')
        );

        return hasDate && amountTokens.length >= 1 && this.isLikelyMerchantName(merchantName);
    }

    static chooseTableTransactionAmountToken(line, tokens) {
        if (tokens.length === 0) return '';
        if (tokens.length === 1) return tokens[0].text;

        const firstAmount = this.parseAmount(tokens[0].text);
        const secondAmount = this.parseAmount(tokens[1].text);

        if (firstAmount === 0 && secondAmount > 0) {
            return tokens[1].text;
        }

        return tokens[0].text;
    }

    static getTrailingBalanceToken(tokens) {
        return tokens.length >= 2 ? tokens[tokens.length - 1] : null;
    }

    static looksLikeStatementAmountRow(line, tokens) {
        if (tokens.length < 2) return false;

        const lower = String(line || '').toLowerCase();
        const hasDate = this.dateTokenRegex().test(line);
        const hasStatementWords = /\b(balance|ending|opening|ledger|posted|available)\b/.test(lower);

        return hasDate || hasStatementWords || tokens.length >= 3;
    }

    static parseAmount(token) {
        const parsed = this.parseSignedAmount(token);
        return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
    }

    static parseSignedAmount(token) {
        const raw = String(token || '');
        const isParenthetical = /\([^)]*\)/.test(raw);
        const normalized = raw
            .replace(/[Oo]/g, '0')
            .replace(/[$,\s]/g, '')
            .replace(/[^0-9.+-]/g, '');

        const parsed = parseFloat(normalized);
        if (!Number.isFinite(parsed)) return NaN;
        return isParenthetical ? -Math.abs(parsed) : parsed;
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
            .replace(/\borig\s+co\s+name\s*:?/gi, ' ')
            .replace(/\bco\s+entry\s+descr\s*:?/gi, ' ')
            .replace(/\bentry\s+descr\s*:?/gi, ' ')
            .replace(/\bpurchase\s+s\b/gi, ' ')
            .replace(/\b(?:trn|trace|auth|authorization|conf|confirmation|reference|ref|id)[:#]?\s*[xX\d.-]{3,}\b/gi, ' ')
            .replace(/\b(?:confirmation#?|conf#?)\s*[xX\d.-]{3,}\b/gi, ' ')
            .replace(/\b[xX]{3,}\d*\b/g, ' ')
            .replace(/\b(?:trn|trace|auth|authorization|conf|confirmation|reference|ref|date|time|id)[:#]?\b/gi, ' ')
            .replace(/\b(pending|posted|complete|completed|debit|purchase|payment|online|transaction|card|tap|contactless|available|authorized)\b/gi, ' ')
            .replace(/\b(today|yesterday|details|view|merchant|statement|activity|balance|account|ending|total|subtotal|summary|transactions|history|search|filter)\b/gi, ' ')
            .replace(/\b\d{2}:\d{2}\b/g, ' ')
            .replace(/\b\d{4,}\b/g, ' ')
            .replace(/[:#]+/g, ' ')
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

    static refineMerchantName(name) {
        const cleaned = this.cleanNameCandidate(name)
            .replace(/\b(?:usa|us)\b$/i, ' ')
            .replace(/\b(?:[A-Z]{2})\s+\d{5}(?:-\d{4})?\b/g, ' ')
            .replace(/\b(?:store|str|terminal|term|loc|location)[:#]?\s*\d+\b/gi, ' ')
            .replace(/\b(?:mktp|marketplace|digital|prime)\b$/gi, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();

        if (!cleaned) return '';

        const lower = cleaned.toLowerCase();
        const knownMerchants = [
            { pattern: /\b(?:amazon|amzn|amazn)\b/, name: 'Amazon' },
            { pattern: /\b(?:whole foods|wholefds|wfm)\b/, name: 'Whole Foods' },
            { pattern: /\btrader\s+joe'?s?\b/, name: "Trader Joe's" },
            { pattern: /\b(?:uber\s*eats|ubereats)\b/, name: 'Uber Eats' },
            { pattern: /\buber\b/, name: 'Uber' },
            { pattern: /\b(?:door\s*dash|doordash)\b/, name: 'DoorDash' },
            { pattern: /\bpaypal\b/, name: 'PayPal' },
            { pattern: /\bapple(?:\.com| services| store| cash)?\b/, name: 'Apple' },
            { pattern: /\bstarbucks?\b|\bstarbcks\b/, name: 'Starbucks' },
            { pattern: /\btarget\b/, name: 'Target' },
            { pattern: /\bwalmart\b|\bwal-mart\b/, name: 'Walmart' },
            { pattern: /\bcostco\b/, name: 'Costco' },
            { pattern: /\bcvs\b/, name: 'CVS' },
            { pattern: /\bwalgreens\b/, name: 'Walgreens' },
            { pattern: /\bmcdonald'?s?\b/, name: "McDonald's" },
            { pattern: /\bnetflix\b/, name: 'Netflix' },
            { pattern: /\bspotify\b/, name: 'Spotify' },
            { pattern: /\bvenmo\b/, name: 'Venmo' },
            { pattern: /\bzelle\b/, name: 'Zelle' },
            { pattern: /\bopenai\b/, name: 'OpenAI' },
            { pattern: /\bdropbox\b/, name: 'Dropbox' }
        ];

        const merchant = knownMerchants.find(item => item.pattern.test(lower));
        if (merchant) return merchant.name;

        return this.toReadableMerchantName(cleaned);
    }

    static toReadableMerchantName(name) {
        const value = String(name || '').replace(/\s+/g, ' ').trim();
        if (!value) return '';

        const hasLowercase = /[a-z]/.test(value);
        const readable = hasLowercase
            ? value
            : value.toLowerCase().replace(/\b[a-z]/g, char => char.toUpperCase());

        return readable
            .replace(/\bAt&T\b/g, 'AT&T')
            .replace(/\bH&M\b/g, 'H&M')
            .replace(/\bCvs\b/g, 'CVS')
            .replace(/\bUsps\b/g, 'USPS')
            .replace(/\bTj\b/g, 'TJ')
            .replace(/\bIkea\b/g, 'IKEA');
    }

    static mergeDateContexts(baseContext, incomingContext) {
        if (!baseContext) return incomingContext || null;
        if (!incomingContext) return baseContext;

        return {
            defaultYear: baseContext.defaultYear || incomingContext.defaultYear || null,
            statementEndDate: baseContext.statementEndDate || incomingContext.statementEndDate || null
        };
    }

    static buildDateContextFromLines(lines, initialDate = '') {
        const yearCounts = new Map();
        let statementEndDate = null;

        const addDate = isoDate => {
            if (!isoDate) return;
            const date = new Date(`${isoDate}T00:00:00`);
            if (Number.isNaN(date.getTime())) return;

            const year = date.getFullYear();
            const currentYear = new Date().getFullYear();
            if (year < currentYear - 15 || year > currentYear + 2) return;

            yearCounts.set(year, (yearCounts.get(year) || 0) + 1);
            if (!statementEndDate || date > statementEndDate) {
                statementEndDate = date;
            }
        };

        addDate(/^\d{4}-\d{2}-\d{2}$/.test(initialDate) ? initialDate : '');

        const text = (lines || []).join(' ');
        const datePatterns = [
            /\b\d{4}[\/-]\d{1,2}[\/-]\d{1,2}\b/g,
            /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g,
            /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{2,4}\b/gi
        ];

        datePatterns.forEach(pattern => {
            const matches = text.match(pattern) || [];
            matches.forEach(match => addDate(this.normalizeDate(match, null)));
        });

        let defaultYear = null;
        [...yearCounts.entries()].forEach(([year, count]) => {
            if (!defaultYear || count > (yearCounts.get(defaultYear) || 0)) {
                defaultYear = year;
            }
        });

        return {
            defaultYear,
            statementEndDate
        };
    }

    static normalizeDate(input, dateContext = null) {
        if (!input) return '';

        const context = typeof dateContext === 'number'
            ? { defaultYear: dateContext }
            : dateContext || {};
        const fallbackYear = context.defaultYear || new Date().getFullYear();
        const value = String(input)
            .replace(/\./g, '')
            .replace(/-/g, '/')
            .replace(/\s+/g, ' ')
            .trim();

        let match = value.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
        if (match) {
            return this.formatNormalizedDate(Number(match[1]), Number(match[2]), Number(match[3]), context, true);
        }

        match = value.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
        if (match) {
            const explicitYear = Boolean(match[3]);
            const year = explicitYear ? this.normalizeDateYear(match[3]) : fallbackYear;
            return this.formatNormalizedDate(year, Number(match[1]), Number(match[2]), context, explicitYear);
        }

        match = value.match(/^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s+(\d{2,4}))?$/i);
        if (match) {
            const explicitYear = Boolean(match[3]);
            const year = explicitYear ? this.normalizeDateYear(match[3]) : fallbackYear;
            return this.formatNormalizedDate(year, this.monthNameToNumber(match[1]), Number(match[2]), context, explicitYear);
        }

        return '';
    }

    static normalizeDateYear(yearText) {
        const year = Number(yearText);
        if (!Number.isFinite(year)) return new Date().getFullYear();
        if (year < 100) return year >= 70 ? 1900 + year : 2000 + year;
        return year;
    }

    static monthNameToNumber(monthName) {
        const key = String(monthName || '').slice(0, 3).toLowerCase();
        return {
            jan: 1,
            feb: 2,
            mar: 3,
            apr: 4,
            may: 5,
            jun: 6,
            jul: 7,
            aug: 8,
            sep: 9,
            oct: 10,
            nov: 11,
            dec: 12
        }[key] || 0;
    }

    static formatNormalizedDate(year, month, day, dateContext = null, explicitYear = false) {
        if (!year || !month || !day) return '';

        let parsed = new Date(year, month - 1, day);
        if (
            Number.isNaN(parsed.getTime()) ||
            parsed.getFullYear() !== year ||
            parsed.getMonth() !== month - 1 ||
            parsed.getDate() !== day
        ) {
            return '';
        }

        if (!explicitYear && dateContext && dateContext.statementEndDate instanceof Date) {
            parsed = this.adjustImplicitYearDate(parsed, dateContext.statementEndDate);
        }

        const normalizedMonth = String(parsed.getMonth() + 1).padStart(2, '0');
        const normalizedDay = String(parsed.getDate()).padStart(2, '0');
        return `${parsed.getFullYear()}-${normalizedMonth}-${normalizedDay}`;
    }

    static adjustImplicitYearDate(date, statementEndDate) {
        const dayMs = 24 * 60 * 60 * 1000;
        const gapDays = (date.getTime() - statementEndDate.getTime()) / dayMs;

        if (gapDays > 45) {
            return new Date(date.getFullYear() - 1, date.getMonth(), date.getDate());
        }

        if (gapDays < -370) {
            return new Date(date.getFullYear() + 1, date.getMonth(), date.getDate());
        }

        return date;
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
            { label: 'table high-res', canvas: this.prepareImageForOCR(image, { mode: 'table', minScale: 3 }), tableOptimized: true },
            { label: 'sharp high-res', canvas: this.prepareImageForOCR(image, { mode: 'contrast', minScale: 2.4 }), tableOptimized: true },
            { label: 'balanced', canvas: this.prepareImageForOCR(image, { mode: 'balanced', minScale: 1.8 }) },
            { label: 'plain', canvas: this.prepareImageForOCR(image, { mode: 'none', minScale: 1.8 }) }
        ];
    }

    static prepareImageForOCR(image, options = {}) {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const requestedScale = Math.max(1, Number(options.minScale) || 1);
        const scale = Math.min(requestedScale, this.MAX_OCR_IMAGE_DIMENSION / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));

        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
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
            } else if (options.mode === 'table') {
                nextValue = grayscale > 220 ? 255 : grayscale < 170 ? 0 : grayscale;
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
        const TesseractApi = await this.ensureTesseract();
        const result = await TesseractApi.recognize(canvas, 'eng', {
            ...this.getTesseractOptions(),
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
