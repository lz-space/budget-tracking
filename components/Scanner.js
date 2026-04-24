class Scanner {
    static MAX_IMAGE_DIMENSION = 1800;
    static MAX_OCR_IMAGE_DIMENSION = 2600;
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
            const ocrData = await this.runOcrDataOnCanvas(variant.canvas, message => {
                statusCallback(`Scanning image ${fileNumber}/${totalFiles} (${variant.label})... ${message}%`);
            });
            const transactions = this.parseImageOcrDataWithState(ocrData, '').transactions;
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
        const lines = this.prepareLines(rawText);
        const tableParsed = this.parseTransactionTableLinesWithState(lines, initialDate);
        const standardParsed = this.parseLinesWithState(lines, initialDate);

        return this.scoreParseResult(tableParsed.transactions) > this.scoreParseResult(standardParsed.transactions)
            ? tableParsed
            : standardParsed;
    }

    static parseImageOcrDataWithState(ocrData, initialDate = '') {
        const positionedTable = this.parsePositionedTransactionTableWithState(ocrData, initialDate);
        const textParsed = this.parseTextWithState((ocrData && ocrData.text) || '', initialDate);

        if (positionedTable.isTable && positionedTable.transactions.length > 0) {
            return positionedTable;
        }

        return this.scoreParseResult(positionedTable.transactions) >= this.scoreParseResult(textParsed.transactions)
            ? positionedTable
            : textParsed;
    }

    static parsePdfOcrDataWithState(ocrData, initialDate = '') {
        const positionedTable = this.parsePositionedTransactionTableWithState(ocrData, initialDate);
        if (positionedTable.transactions.length > 0) {
            return positionedTable;
        }

        const positionedLines = this.extractOcrPositionedLines(ocrData);
        if (positionedLines.length > 0) {
            const tableParsed = this.parseTransactionTableLinesWithState(positionedLines, initialDate);
            if (tableParsed.transactions.length > 0) {
                return tableParsed;
            }

            const parsed = this.parseLinesWithState(positionedLines, initialDate);
            if (parsed.transactions.length > 0) {
                return parsed;
            }
        }

        return this.parseTextWithState((ocrData && ocrData.text) || '', initialDate);
    }

    static parseTransactionTableLinesWithState(lines, initialDate = '') {
        const transactions = [];
        const dateRegex = this.dateTokenRegex();
        let activeDate = initialDate || '';

        lines.forEach(line => {
            const normalizedLine = this.normalizeText(line);
            if (!this.looksLikeTransactionTableLine(normalizedLine)) return;

            const dateMatch = normalizedLine.match(dateRegex);
            const lineDate = dateMatch ? this.normalizeDate(dateMatch[0]) : activeDate;
            if (dateMatch && lineDate) activeDate = lineDate;

            const amountTokens = this.extractAmountTokens(normalizedLine);
            if (amountTokens.length === 0) return;

            const amountToken = this.chooseTableTransactionAmountToken(normalizedLine, amountTokens);
            const amount = this.parseAmount(amountToken);
            if (!this.isReasonableAmount(amount)) return;

            const name = this.cleanNameCandidate(
                normalizedLine
                    .slice(0, amountTokens[0].index)
                    .replace(dateRegex, ' ')
                    .replace(/\b(type|amount|balance|description|posting date)\b/gi, ' ')
            );
            if (!this.isLikelyMerchantName(name)) return;

            const categorized = CategorizationEngine.categorize(name, CategorizationEngine.guessType(name, amountToken));
            transactions.push({
                date: lineDate,
                name,
                amount,
                type: categorized.type,
                category: categorized.c,
                subCategory: categorized.s
            });
        });

        return {
            transactions,
            lastActiveDate: activeDate
        };
    }

    static parsePositionedTransactionTableWithState(ocrData, initialDate = '') {
        const positionedWords = this.extractPositionedWords(ocrData);
        const rows = this.extractOcrRows(ocrData);
        if (rows.length === 0) {
            return { transactions: [], lastActiveDate: initialDate || '', isTable: false };
        }

        const allRows = this.groupWordsIntoRows(positionedWords);
        const columnHints = this.detectTransactionTableColumns(allRows.length > rows.length ? allRows : rows);
        if (!columnHints) {
            return { transactions: [], lastActiveDate: initialDate || '', isTable: false };
        }

        const transactions = [];
        const dateRegex = this.dateTokenRegex();
        let activeDate = initialDate || '';

        rows.forEach(row => {
            const line = this.normalizeText(row.text);
            if (!line || this.isTableHeaderOrSummaryLine(line)) return;

            const dateMatch = this.getPositionedTableDateMatch(row, columnHints);
            const hasStatusAnchor = this.hasPositionedStatusAnchor(row, columnHints);
            if (!dateMatch && !hasStatusAnchor) return;

            const lineDate = dateMatch ? this.normalizeDate(dateMatch[0]) : '';
            if (dateMatch && !lineDate) return;
            if (lineDate) activeDate = lineDate;

            const moneyWords = this.extractMoneyWords(row.words);
            if (moneyWords.length === 0) return;

            const amountWord = this.choosePositionedAmountWord(moneyWords, columnHints);
            if (!amountWord) return;

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
            const categorized = CategorizationEngine.categorize(name, inferredType);
            transactions.push({
                date: lineDate,
                name,
                amount,
                type: categorized.type,
                category: categorized.c,
                subCategory: categorized.s
            });
        });

        return {
            transactions,
            lastActiveDate: activeDate,
            isTable: true
        };
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
