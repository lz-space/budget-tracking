let pendingTransactions = [];
let editingTransactionId = null;
let currentMonthView = null;
let transactionSearchTerm = '';
let transactionCategoryFilter = null;

const PIE_COLORS = ['#d67b44', '#2d7a53', '#5d8db8', '#b2574f', '#8c6db4', '#d1a84a', '#72825e', '#d98080'];
const BACKUP_VERSION = 1;
const BACKUP_KDF_ITERATIONS = 250000;
const LOCAL_APP_URL = 'http://127.0.0.1:8013/';

document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

function initApp() {
    setupTabs();
    setupOverviewInteractions();
    setupImportListeners();
    setupManualEntry();
    setupModalListeners();
    setupCategoryListeners();
    setupDataManagementListeners();
    setupTransactionSearch();
    initializeManualForm();
    renderAll();
}

function setupOverviewInteractions() {
    const toggleButton = document.getElementById('toggle-transactions');
    const panelBody = document.getElementById('transactions-panel-body');
    const monthlyToggleButton = document.getElementById('toggle-monthly-summary');
    const monthlyPanelBody = document.getElementById('monthly-summary-body');
    const categoryList = document.getElementById('category-summary-list');
    const clearFilterButton = document.getElementById('clear-transaction-filter');

    toggleButton.addEventListener('click', () => {
        const isCollapsed = panelBody.classList.toggle('collapsed');
        toggleButton.textContent = isCollapsed ? 'Expand' : 'Collapse';
        toggleButton.setAttribute('aria-expanded', String(!isCollapsed));
    });

    monthlyToggleButton.addEventListener('click', () => {
        const isCollapsed = monthlyPanelBody.classList.toggle('collapsed');
        monthlyToggleButton.textContent = isCollapsed ? 'Expand' : 'Collapse';
        monthlyToggleButton.setAttribute('aria-expanded', String(!isCollapsed));
    });

    categoryList.addEventListener('click', event => {
        const categoryItem = event.target.closest('.cat-item[data-category]');
        if (!categoryItem) return;

        activateCategoryTransactionFilter(categoryItem.dataset.category, categoryItem.dataset.type || null);
    });

    categoryList.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const categoryItem = event.target.closest('.cat-item[data-category]');
        if (!categoryItem) return;

        event.preventDefault();
        activateCategoryTransactionFilter(categoryItem.dataset.category, categoryItem.dataset.type || null);
    });

    clearFilterButton.addEventListener('click', () => {
        transactionCategoryFilter = null;
        renderOverview();
    });
}

function activateCategoryTransactionFilter(category, type = null) {
    const toggleButton = document.getElementById('toggle-transactions');
    const panelBody = document.getElementById('transactions-panel-body');

    transactionCategoryFilter = {
        category,
        month: currentMonthView,
        type
    };
    panelBody.classList.remove('collapsed');
    toggleButton.textContent = 'Collapse';
    toggleButton.setAttribute('aria-expanded', 'true');
    renderOverview();
    document.getElementById('transactions-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderAll() {
    ensureSavedTransactionCategories();
    renderOverview();
    renderCategoryEditor();
    initializeManualForm();
    refreshPendingPreviewCategories();
}

function ensureSavedTransactionCategories() {
    CategoryService.ensureSelectionsFromTransactions(StorageService.getTransactions());
}

function setupTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    const sections = document.querySelectorAll('.view-section');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(item => item.classList.remove('active'));
            sections.forEach(section => section.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.target).classList.add('active');

            if (tab.dataset.target === 'overview') renderOverview();
            if (tab.dataset.target === 'categories') renderCategoryEditor();
            if (tab.dataset.target === 'import') {
                initializeManualForm();
                refreshPendingPreviewCategories();
            }
        });
    });
}

function setupImportListeners() {
    const fileInput = document.getElementById('file-input');
    const statusMsg = document.getElementById('ocr-status');
    const helpBox = document.getElementById('ocr-help');
    const isFilePage = window.location.protocol === 'file:';

    if (isFilePage) {
        showLocalServerHelp(helpBox);
        fileInput.disabled = true;
        fileInput.closest('.file-drop-zone').classList.add('disabled-drop-zone');
    }

    fileInput.addEventListener('change', async () => {
        if (isFilePage) {
            showLocalServerHelp(helpBox);
            fileInput.value = '';
            return;
        }

        helpBox.classList.add('hidden');
        helpBox.textContent = '';
        statusMsg.classList.remove('hidden');
        let transactions = [];
        try {
            transactions = await Scanner.processFiles(fileInput, message => {
                statusMsg.textContent = message;
            });
        } catch (err) {
            console.error('Scan error:', err);
            transactions = { error: 'An unexpected error occurred during scanning: ' + err.message };
        }
        
        statusMsg.classList.add('hidden');
        if (transactions.error) {
            helpBox.textContent = transactions.error;
            helpBox.classList.remove('hidden');
            return;
        } else if (transactions.length === 0) {
            helpBox.textContent = buildMobileScanHelp();
            helpBox.classList.remove('hidden');
        }
        showPreview(transactions);
        fileInput.value = '';
    });

    document.getElementById('cancel-import').addEventListener('click', () => {
        pendingTransactions = [];
        document.getElementById('import-preview-area').classList.add('hidden');
    });

    document.getElementById('save-import').addEventListener('click', () => {
        const rows = document.querySelectorAll('.editable-tx-row');
        let hasMissingFields = false;

        const reviewedRows = Array.from(rows).map(row => {
            const index = Number(row.dataset.index);
            const dateInput = row.querySelector('.tx-edit-date');
            if (!dateInput.value) {
                hasMissingFields = true;
                dateInput.style.border = '2px solid red';
            } else {
                dateInput.style.border = '';
            }
            const skipToggle = row.querySelector('.tx-skip-duplicate');
            return {
                transaction: buildTransactionFromRow(row, pendingTransactions[index] || {}),
                skipDuplicate: Boolean(skipToggle && skipToggle.checked),
                duplicateOverride: Boolean(skipToggle && !skipToggle.checked)
            };
        });

        if (hasMissingFields) {
            alert('Please review and fill in all missing transaction details (highlighted in red) before saving.');
            return;
        }

        const savePlan = planTransactionsForImportSave(reviewedRows);
        if (savePlan.transactionsToSave.length > 0) {
            StorageService.saveMultipleTransactions(savePlan.transactionsToSave);
        }

        pendingTransactions = [];
        document.getElementById('import-preview-area').classList.add('hidden');
        document.querySelector('[data-target="overview"]').click();

        if (savePlan.skippedDuplicates.length > 0) {
            alert(`${savePlan.transactionsToSave.length} new transaction${savePlan.transactionsToSave.length === 1 ? '' : 's'} saved. ${savePlan.skippedDuplicates.length} likely duplicate${savePlan.skippedDuplicates.length === 1 ? '' : 's'} skipped.`);
        }
    });

    document.getElementById('preview-list').addEventListener('click', event => {
        const removeButton = event.target.closest('.remove-preview-btn');
        if (!removeButton) return;

        const index = Number(removeButton.dataset.index);
        if (Number.isNaN(index)) return;

        capturePendingPreviewEdits();
        pendingTransactions.splice(index, 1);

        if (pendingTransactions.length === 0) {
            document.getElementById('import-preview-area').classList.add('hidden');
            return;
        }

        showPreview(pendingTransactions);
    });
}

function showLocalServerHelp(helpBox) {
    helpBox.textContent = '';
    const message = document.createElement('span');
    message.textContent = 'This page is open as file://, so the browser blocks PDF and OCR scanning. Open the local web app instead: ';
    const link = document.createElement('a');
    link.href = LOCAL_APP_URL;
    link.textContent = LOCAL_APP_URL;
    helpBox.append(message, link);
    helpBox.classList.remove('hidden');
}

function setupManualEntry() {
    const manualCategory = document.getElementById('manual-category');
    const manualSubcategory = document.getElementById('manual-subcat');
    const manualName = document.getElementById('manual-name');
    const manualType = document.getElementById('manual-type');

    manualCategory.addEventListener('change', event => {
        populateSubcategorySelect(manualSubcategory, event.target.value, '');
    });

    manualName.addEventListener('blur', () => {
        const name = manualName.value.trim();
        if (!name) return;

        const guess = CategorizationEngine.categorize(name, manualType.value);
        manualType.value = guess.type;
        populateCategorySelect(manualCategory, guess.c);
        populateSubcategorySelect(manualSubcategory, guess.c, guess.s);
    });

    manualType.addEventListener('change', () => {
        const name = manualName.value.trim();
        if (!name) return;
        const guess = CategorizationEngine.categorize(name, manualType.value);
        populateCategorySelect(manualCategory, guess.c);
        populateSubcategorySelect(manualSubcategory, guess.c, guess.s);
    });

    document.getElementById('save-manual-btn').addEventListener('click', () => {
        const selection = CategoryService.validateSelection(manualCategory.value, manualSubcategory.value);
        const transaction = {
            date: document.getElementById('manual-date').value,
            name: manualName.value.trim(),
            amount: parseFloat(document.getElementById('manual-amount').value) || 0,
            type: manualType.value,
            category: selection.category,
            subCategory: selection.subCategory
        };

        if (!transaction.name || !transaction.amount) {
            alert('Please add a name and amount before saving.');
            return;
        }

        StorageService.saveTransaction(transaction);
        CategorizationEngine.learnMapping(transaction.name, transaction.category, transaction.subCategory);
        resetManualForm();
        document.querySelector('[data-target="overview"]').click();
    });
}

function initializeManualForm() {
    const dateInput = document.getElementById('manual-date');
    if (!dateInput.value) {
        dateInput.value = new Date().toISOString().split('T')[0];
    }

    const defaultCategory = CategoryService.validateSelection('Other', 'General');
    populateCategorySelect(document.getElementById('manual-category'), defaultCategory.category);
    populateSubcategorySelect(document.getElementById('manual-subcat'), defaultCategory.category, defaultCategory.subCategory);
}

function resetManualForm() {
    document.getElementById('manual-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('manual-name').value = '';
    document.getElementById('manual-amount').value = '';
    document.getElementById('manual-type').value = 'expense';
    initializeManualForm();
}

function setupTransactionSearch() {
    document.getElementById('transaction-search').addEventListener('input', event => {
        transactionSearchTerm = event.target.value.trim().toLowerCase();
        renderDashboard();
    });
}

function setupModalListeners() {
    const modal = document.getElementById('edit-modal');
    const catSelect = document.getElementById('edit-category');
    const subSelect = document.getElementById('edit-subcat');

    catSelect.addEventListener('change', event => {
        populateSubcategorySelect(subSelect, event.target.value, '');
    });

    document.getElementById('cancel-edit').addEventListener('click', () => {
        modal.classList.add('hidden');
        editingTransactionId = null;
    });

    document.getElementById('save-edit').addEventListener('click', () => {
        if (!editingTransactionId) return;

        const selection = CategoryService.validateSelection(
            document.getElementById('edit-category').value,
            document.getElementById('edit-subcat').value
        );

        const updatedTransaction = {
            id: editingTransactionId,
            date: document.getElementById('edit-date').value,
            name: document.getElementById('edit-name').value,
            amount: parseFloat(document.getElementById('edit-amount').value) || 0,
            type: document.getElementById('edit-type').value,
            category: selection.category,
            subCategory: selection.subCategory
        };

        StorageService.updateTransaction(updatedTransaction);
        CategorizationEngine.learnMapping(updatedTransaction.name, updatedTransaction.category, updatedTransaction.subCategory);
        modal.classList.add('hidden');
        editingTransactionId = null;
        renderAll();
    });

    document.getElementById('delete-edit').addEventListener('click', () => {
        if (!editingTransactionId) return;
        StorageService.deleteTransaction(editingTransactionId);
        modal.classList.add('hidden');
        editingTransactionId = null;
        renderAll();
    });
}

function openEditModal(transaction) {
    editingTransactionId = transaction.id;
    document.getElementById('edit-date').value = transaction.date;
    document.getElementById('edit-name').value = transaction.name;
    document.getElementById('edit-amount').value = transaction.amount;
    document.getElementById('edit-type').value = transaction.type;
    populateCategorySelect(document.getElementById('edit-category'), transaction.category);
    populateSubcategorySelect(document.getElementById('edit-subcat'), transaction.category, transaction.subCategory);
    document.getElementById('edit-modal').classList.remove('hidden');
}

function buildTransactionFromRow(row, draft) {
    const transaction = readTransactionFromRow(row, draft);
    CategorizationEngine.learnMapping(transaction.name, transaction.category, transaction.subCategory);
    return transaction;
}

function readTransactionFromRow(row, draft) {
    const selection = CategoryService.validateSelection(
        row.querySelector('.tx-edit-category').value,
        row.querySelector('.tx-edit-subcat').value
    );

    return {
        id: draft.id,
        date: row.querySelector('.tx-edit-date').value,
        name: row.querySelector('.tx-edit-name').value,
        amount: parseFloat(row.querySelector('.tx-edit-amount').value) || 0,
        type: row.querySelector('.tx-edit-type').value,
        category: selection.category,
        subCategory: selection.subCategory,
        scanBalanceAfter: draft.scanBalanceAfter,
        scanBalanceMatched: draft.scanBalanceMatched,
        scanWarning: draft.scanWarning
    };
}

function capturePendingPreviewEdits() {
    document.querySelectorAll('.editable-tx-row').forEach((row, index) => {
        const dataIndex = Number(row.dataset.index);
        const pendingIndex = Number.isNaN(dataIndex) ? index : dataIndex;
        if (!pendingTransactions[pendingIndex]) return;

        pendingTransactions[pendingIndex] = readTransactionFromRow(row, pendingTransactions[pendingIndex]);
    });
}

function showPreview(transactions) {
    const previewList = document.getElementById('preview-list');
    const previewArea = document.getElementById('import-preview-area');

    if (transactions.length === 0) {
        alert('No transactions were detected. Try a cleaner screenshot.');
        return;
    }

    pendingTransactions = transactions;
    previewList.innerHTML = '';
    const duplicateHints = detectDuplicateWarnings(transactions);

    transactions.forEach((transaction, index) => {
        const hint = duplicateHints[index];
        const scanHint = buildScanReviewHint(transaction);
        const skipDuplicateControl = hint && hint.defaultSkip
            ? `<label class="skip-duplicate-toggle"><input type="checkbox" class="tx-skip-duplicate" checked> Skip duplicate</label>`
            : '';
        const row = document.createElement('div');
        row.className = 'editable-tx-row';
        row.dataset.index = String(index);
        row.innerHTML = `
            <div class="preview-row-head">
                <div class="preview-hints">
                    ${scanHint ? `<span class="duplicate-pill ${scanHint.level}">${escapeHtml(scanHint.label)}</span>` : ''}
                    ${hint ? `<span class="duplicate-pill ${hint.level}">${escapeHtml(hint.label)}</span>` : ''}
                </div>
                <div class="preview-row-actions">
                    ${skipDuplicateControl}
                    <button class="btn danger mini-btn remove-preview-btn" type="button" data-index="${index}">Remove</button>
                </div>
            </div>
            <div class="inline-row">
                <input type="date" value="${transaction.date}" class="form-input tx-edit-date">
                <select class="form-input tx-edit-type">
                    <option value="expense" ${transaction.type === 'expense' ? 'selected' : ''}>Expense</option>
                    <option value="income" ${transaction.type === 'income' ? 'selected' : ''}>Income</option>
                </select>
            </div>
            <div class="inline-row">
                <input type="text" value="${escapeHtml(transaction.name)}" class="form-input tx-edit-name">
                <input type="number" step="0.01" value="${transaction.amount.toFixed(2)}" class="form-input tx-edit-amount">
            </div>
            <div class="inline-row">
                <select class="form-input tx-edit-category"></select>
                <select class="form-input tx-edit-subcat"></select>
            </div>
            ${scanHint ? `<p class="preview-note">${escapeHtml(scanHint.message)}</p>` : ''}
            ${hint ? `<p class="preview-note">${escapeHtml(hint.message)}</p>` : ''}
        `;

        const categorySelect = row.querySelector('.tx-edit-category');
        const subcategorySelect = row.querySelector('.tx-edit-subcat');
        populateCategorySelect(categorySelect, transaction.category);
        populateSubcategorySelect(subcategorySelect, transaction.category, transaction.subCategory);

        categorySelect.addEventListener('change', event => {
            populateSubcategorySelect(subcategorySelect, event.target.value, '');
        });

        previewList.appendChild(row);
    });

    previewArea.classList.remove('hidden');
}

function buildScanReviewHint(transaction) {
    if (transaction.scanWarning) {
        return {
            level: 'strong',
            label: 'Review amount',
            message: transaction.scanWarning
        };
    }

    if (transaction.scanBalanceMatched && Number.isFinite(transaction.scanBalanceAfter)) {
        return {
            level: 'soft',
            label: 'Balance checked',
            message: `Amount matches the running balance ending at ${formatReviewMoney(transaction.scanBalanceAfter)}.`
        };
    }

    if (Number.isFinite(transaction.scanBalanceAfter)) {
        return {
            level: 'soft',
            label: 'Balance seen',
            message: `Running balance shown after this transaction: ${formatReviewMoney(transaction.scanBalanceAfter)}.`
        };
    }

    return null;
}

function formatReviewMoney(value) {
    const amount = Math.round((Number(value) || 0) * 100) / 100;
    return `${amount < 0 ? '-' : ''}$${Math.abs(amount).toFixed(2)}`;
}

function refreshPendingPreviewCategories() {
    if (!pendingTransactions.length) return;

    const previewArea = document.getElementById('import-preview-area');
    if (previewArea.classList.contains('hidden')) return;

    document.querySelectorAll('.editable-tx-row').forEach((row, index) => {
        const dataIndex = Number(row.dataset.index);
        const draft = pendingTransactions[dataIndex] || pendingTransactions[index] || {};
        const categorySelect = row.querySelector('.tx-edit-category');
        const subcategorySelect = row.querySelector('.tx-edit-subcat');
        const currentCategory = categorySelect.value || draft.category;
        const currentSubcategory = subcategorySelect.value || draft.subCategory;
        const selection = CategoryService.validateSelection(currentCategory, currentSubcategory);

        populateCategorySelect(categorySelect, selection.category);
        populateSubcategorySelect(subcategorySelect, selection.category, selection.subCategory);
    });
}

const DUPLICATE_WARN_SCORE = 0.68;
const DUPLICATE_SKIP_SCORE = 0.86;
const DUPLICATE_DATE_WINDOW_DAYS = 3;
const DUPLICATE_STOP_WORDS = new Set([
    'ach', 'auth', 'authorized', 'card', 'checkcard', 'co', 'company', 'corp', 'credit',
    'debit', 'dbt', 'hold', 'inc', 'llc', 'ltd', 'market', 'marketplace', 'mktp',
    'mobile', 'online', 'pay', 'payment', 'pending', 'pos', 'posted', 'purchase',
    'recurring', 'sq', 'store', 'terminal', 'transaction', 'tst', 'us', 'usa', 'visa',
    'withdrawal', 'www', 'com', 'net', 'org', 'help',
    'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'dc', 'de', 'fl', 'ga', 'hi', 'ia', 'id',
    'il', 'in', 'ks', 'ky', 'la', 'ma', 'md', 'me', 'mi', 'mn', 'mo', 'ms', 'mt', 'nc',
    'nd', 'ne', 'nh', 'nj', 'nm', 'nv', 'ny', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd',
    'tn', 'tx', 'ut', 'va', 'vt', 'wa', 'wi', 'wv', 'wy'
]);

function detectDuplicateWarnings(transactions) {
    const savedEntries = StorageService.getTransactions().map(transaction => ({
        transaction,
        source: 'saved'
    }));
    const scannedEntries = [];
    const warnings = {};

    transactions.forEach((transaction, index) => {
        const match = findBestDuplicateMatch(transaction, savedEntries.concat(scannedEntries));

        if (match) {
            warnings[index] = buildDuplicateWarning(match);
        }

        scannedEntries.push({
            transaction,
            source: 'scan'
        });
    });

    return warnings;
}

function planTransactionsForImportSave(reviewedRows) {
    const savedEntries = StorageService.getTransactions().map(transaction => ({
        transaction,
        source: 'saved'
    }));
    const acceptedEntries = [];
    const transactionsToSave = [];
    const skippedDuplicates = [];

    reviewedRows.forEach((row, index) => {
        const transaction = row.transaction;
        if (row.skipDuplicate) {
            skippedDuplicates.push({ index, transaction, reason: 'checked' });
            return;
        }

        const match = row.duplicateOverride
            ? null
            : findBestDuplicateMatch(transaction, savedEntries.concat(acceptedEntries));

        if (match && match.shouldSkip) {
            skippedDuplicates.push({ index, transaction, reason: 'matched', match });
            return;
        }

        transactionsToSave.push(transaction);
        acceptedEntries.push({
            transaction,
            source: 'scan'
        });
    });

    return {
        transactionsToSave,
        skippedDuplicates
    };
}

function buildDuplicateWarning(match) {
    const transaction = match.transaction;
    const sourceLabel = match.source === 'scan' ? 'another scanned row' : 'a saved transaction';
    const amount = Number(transaction.amount || 0).toFixed(2);
    const confidence = Math.round(match.score * 100);

    return {
        level: match.shouldSkip ? 'strong' : 'soft',
        label: match.shouldSkip ? 'Will skip duplicate' : 'Possible duplicate',
        defaultSkip: match.shouldSkip,
        message: `${match.shouldSkip ? 'Strong match' : 'Similar match'} to ${sourceLabel}: ${transaction.name} for $${amount} on ${transaction.date}. Match confidence ${confidence}%.`
    };
}

function findBestDuplicateMatch(transaction, candidateEntries) {
    const left = buildDuplicateFingerprint(transaction);
    let bestMatch = null;

    candidateEntries.forEach(entry => {
        const candidate = entry.transaction || entry;
        const right = buildDuplicateFingerprint(candidate);
        const score = scoreDuplicateMatch(left, right);

        if (score < DUPLICATE_WARN_SCORE) return;
        if (!bestMatch || score > bestMatch.score) {
            bestMatch = {
                transaction: candidate,
                source: entry.source || 'saved',
                score,
                shouldSkip: score >= DUPLICATE_SKIP_SCORE
            };
        }
    });

    return bestMatch;
}

function buildDuplicateFingerprint(transaction) {
    const normalizedName = normalizeDuplicateName(transaction.name);
    const tokens = normalizedName.split(' ').filter(Boolean);

    return {
        amountCents: Math.round((Number(transaction.amount) || 0) * 100),
        compactName: normalizedName.replace(/\s+/g, ''),
        dateTime: parseDuplicateDate(transaction.date),
        normalizedName,
        tokenSet: new Set(tokens),
        tokens,
        type: transaction.type || ''
    };
}

function scoreDuplicateMatch(left, right) {
    if (!left.amountCents || left.amountCents !== right.amountCents) return 0;

    const dateGap = Math.abs(left.dateTime - right.dateTime) / (24 * 60 * 60 * 1000);
    if (!Number.isFinite(dateGap) || dateGap > DUPLICATE_DATE_WINDOW_DAYS) return 0;

    const nameScore = duplicateNameScore(left, right);
    if (nameScore < 0.58) return 0;

    const dateScore = 1 - (dateGap / DUPLICATE_DATE_WINDOW_DAYS) * 0.18;
    const typeScore = left.type && right.type && left.type !== right.type ? 0.88 : 1;

    return (nameScore * 0.78) + (dateScore * 0.14) + (typeScore * 0.08);
}

function duplicateNameScore(left, right) {
    if (!left.compactName || !right.compactName) return 0;
    if (left.compactName === right.compactName) return 1;

    const shorter = left.compactName.length <= right.compactName.length ? left.compactName : right.compactName;
    const longer = left.compactName.length > right.compactName.length ? left.compactName : right.compactName;
    const containsScore = shorter.length >= 4 && longer.includes(shorter)
        ? Math.min(0.96, 0.82 + (shorter.length / longer.length) * 0.14)
        : 0;

    const intersectionSize = countTokenIntersection(left.tokenSet, right.tokenSet);
    const minTokenCount = Math.min(left.tokenSet.size, right.tokenSet.size) || 1;
    const totalTokenCount = (left.tokenSet.size + right.tokenSet.size) || 1;
    const tokenContainment = intersectionSize / minTokenCount;
    const tokenDice = (2 * intersectionSize) / totalTokenCount;
    const tokenScore = Math.max(tokenContainment * 0.92, tokenDice);

    const editScore = 1 - (levenshteinDistance(left.compactName, right.compactName) / Math.max(left.compactName.length, right.compactName.length));
    const sharedLongTokenScore = hasSharedLongToken(left.tokenSet, right.tokenSet) ? 0.72 : 0;

    return Math.max(containsScore, tokenScore, editScore, sharedLongTokenScore);
}

function countTokenIntersection(leftSet, rightSet) {
    let count = 0;
    leftSet.forEach(token => {
        if (rightSet.has(token)) count += 1;
    });
    return count;
}

function hasSharedLongToken(leftSet, rightSet) {
    let shared = false;
    leftSet.forEach(token => {
        if (token.length >= 6 && rightSet.has(token)) shared = true;
    });
    return shared;
}

function parseDuplicateDate(dateValue) {
    const value = String(dateValue || '').trim();
    if (!value) return NaN;

    const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
    const time = new Date(isoDate).getTime();
    return Number.isFinite(time) ? time : NaN;
}

function normalizeDuplicateName(name) {
    const refinedName = window.Scanner && typeof Scanner.refineMerchantName === 'function'
        ? Scanner.refineMerchantName(name)
        : name;
    let normalized = String(refinedName || name || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(/\bamazn\b|\bamzn\b/g, ' amazon ')
        .replace(/\bamazon\s*(mkt|mktp|marketplace|prime|digital)\b/g, ' amazon ')
        .replace(/\bwholefds\b|\bwfm\b/g, ' whole foods ')
        .replace(/\buber\s*(trip|eats)?\b|\bubereats\b/g, ' uber ')
        .replace(/\bdoor\s*dash\b|\bdoordash\b/g, ' door dash ')
        .replace(/\bmcdonalds\b/g, ' mcdonald ')
        .replace(/\bstarbcks\b/g, ' starbucks ')
        .replace(/\bpay\s*pal\b/g, ' paypal ')
        .replace(/\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/g, ' ')
        .replace(/\b\d{4}[\/-]\d{1,2}[\/-]\d{1,2}\b/g, ' ')
        .replace(/\b[0-9a-f]{6,}\b/g, ' ')
        .replace(/\d+/g, ' ')
        .replace(/[^a-z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const tokens = normalized
        .split(' ')
        .filter(token => token.length > 1 && !DUPLICATE_STOP_WORDS.has(token));

    normalized = tokens.join(' ').trim();
    return normalized || String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function levenshteinDistance(left, right) {
    const rows = left.length + 1;
    const cols = right.length + 1;
    const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

    for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
    for (let j = 0; j < cols; j += 1) matrix[0][j] = j;

    for (let i = 1; i < rows; i += 1) {
        for (let j = 1; j < cols; j += 1) {
            const cost = left[i - 1] === right[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }

    return matrix[rows - 1][cols - 1];
}

function renderOverview() {
    renderDashboard();
    renderMonthlySummary();
}

function renderDashboard() {
    const list = document.getElementById('transaction-list');
    const balanceElement = document.getElementById('total-balance');
    const countElement = document.getElementById('transaction-count');
    const filterPill = document.getElementById('active-transaction-filter');
    const filterLabel = document.getElementById('transaction-filter-label');
    const transactions = StorageService.getTransactions();

    list.innerHTML = '';

    const totalBalanceCents = transactions.reduce((sum, transaction) => {
        const amountCents = toCents(transaction.amount);
        return sum + (transaction.type === 'income' ? amountCents : -amountCents);
    }, 0);

    balanceElement.textContent = `${totalBalanceCents < 0 ? '-' : ''}${formatCents(totalBalanceCents)}`;
    balanceElement.className = `summary-amount ${totalBalanceCents >= 0 ? 'positive' : 'negative'}`;

    const filteredTransactions = transactions.filter(transaction => {
        const displayTransaction = getDisplayTransaction(transaction);
        if (transactionCategoryFilter) {
            const inSelectedMonth = transactionCategoryFilter.month
                ? String(transaction.date || '').startsWith(transactionCategoryFilter.month)
                : true;
            const matchesType = transactionCategoryFilter.type
                ? transaction.type === transactionCategoryFilter.type
                : true;
            if (!inSelectedMonth || !matchesType || displayTransaction.category !== transactionCategoryFilter.category) {
                return false;
            }
        }

        if (!transactionSearchTerm) return true;
        const haystack = `${transaction.name} ${displayTransaction.category} ${displayTransaction.subCategory}`.toLowerCase();
        return haystack.includes(transactionSearchTerm);
    });

    countElement.textContent = `${filteredTransactions.length} shown`;
    if (transactionCategoryFilter) {
        const typeLabel = transactionCategoryFilter.type === 'income' ? 'Income' : transactionCategoryFilter.type === 'expense' ? 'Expense' : 'All';
        filterLabel.textContent = `${transactionCategoryFilter.category} · ${typeLabel} · ${formatMonthLabel(transactionCategoryFilter.month)}`;
        filterPill.classList.remove('hidden');
    } else {
        filterPill.classList.add('hidden');
    }

    if (filteredTransactions.length === 0) {
        const emptyTitle = transactions.length ? 'No matches' : 'No transactions yet';
        const emptyHint = transactionCategoryFilter
            ? 'Try another category or clear the filter.'
            : transactions.length
                ? 'Try a different search.'
                : 'Go to Add to scan or enter your first transaction.';
        list.innerHTML = `<li class="tx-item"><div class="tx-left"><span class="tx-name">${emptyTitle}</span><span class="tx-date">${emptyHint}</span></div></li>`;
        if (!transactions.length) {
            balanceElement.textContent = '$0.00';
            balanceElement.className = 'summary-amount';
        }
        return;
    }

    filteredTransactions.forEach(transaction => {
        const displayTransaction = getDisplayTransaction(transaction);
        const item = document.createElement('li');
        item.className = 'tx-item';
        item.innerHTML = `
            <div class="tx-left">
                <span class="tx-name">${escapeHtml(transaction.name)}</span>
                <span class="tx-date">${transaction.date}</span>
                <span class="tx-cat">${escapeHtml(displayTransaction.category)} / ${escapeHtml(displayTransaction.subCategory)}</span>
            </div>
            <div class="tx-amount ${transaction.type}">
                ${transaction.type === 'income' ? '+' : '-'}$${transaction.amount.toFixed(2)}
            </div>
        `;
        item.addEventListener('click', () => openEditModal(transaction));
        list.appendChild(item);
    });
}

function renderMonthlySummary() {
    const transactions = StorageService.getTransactions();
    const monthSelect = document.getElementById('month-select');
    const months = [...new Set(transactions.map(transaction => getMonthKey(transaction.date)).filter(Boolean))].sort().reverse();

    if (months.length === 0) {
        monthSelect.innerHTML = '<option>No data</option>';
        updateMonthlyBreakdown([], null);
        return;
    }

    let selectedMonth = monthSelect.value;
    monthSelect.innerHTML = '';

    months.forEach(monthValue => {
        const option = document.createElement('option');
        option.value = monthValue;
        const [year, month] = monthValue.split('-');
        option.textContent = new Date(Number(year), Number(month) - 1).toLocaleString('default', {
            month: 'long',
            year: 'numeric'
        });
        if (monthValue === selectedMonth) option.selected = true;
        monthSelect.appendChild(option);
    });

    if (!months.includes(selectedMonth)) {
        selectedMonth = months[0];
        monthSelect.value = selectedMonth;
    }

    monthSelect.onchange = () => {
        transactionCategoryFilter = null;
        updateMonthlyBreakdown(transactions, monthSelect.value);
        renderDashboard();
    };
    updateMonthlyBreakdown(transactions, selectedMonth);
}

function updateMonthlyBreakdown(transactions, monthPrefix) {
    const categoryList = document.getElementById('category-summary-list');

    if (!monthPrefix) {
        document.getElementById('month-income').textContent = '$0.00';
        document.getElementById('month-expense').textContent = '$0.00';
        document.getElementById('month-net').textContent = '$0.00';
        categoryList.innerHTML = '<li class="cat-item">No month selected yet.</li>';
        drawMonthlyPieChart([]);
        return;
    }

    currentMonthView = monthPrefix;
    const monthTransactions = transactions
        .filter(transaction => getMonthKey(transaction.date) === monthPrefix)
        .map(transaction => getDisplayTransaction(transaction));
    let incomeTotalCents = 0;
    let expenseTotalCents = 0;
    const expenseBuckets = Object.create(null);
    const incomeBuckets = Object.create(null);

    monthTransactions.forEach(transaction => {
        const amountCents = toCents(transaction.amount);
        if (transaction.type === 'income') {
            incomeTotalCents += amountCents;
            addSummaryBucket(incomeBuckets, transaction, amountCents);
            return;
        }

        expenseTotalCents += amountCents;
        addSummaryBucket(expenseBuckets, transaction, amountCents);
    });

    document.getElementById('month-income').textContent = `+${formatCents(incomeTotalCents)}`;
    document.getElementById('month-expense').textContent = `-${formatCents(expenseTotalCents)}`;

    const netCents = incomeTotalCents - expenseTotalCents;
    const netElement = document.getElementById('month-net');
    netElement.textContent = `${netCents < 0 ? '-' : '+'}${formatCents(netCents)}`;
    netElement.style.color = netCents >= 0 ? 'var(--income)' : 'var(--expense)';

    const sortedExpenses = Object.entries(expenseBuckets).sort((left, right) => right[1].totalCents - left[1].totalCents);
    const sortedIncome = Object.entries(incomeBuckets).sort((left, right) => right[1].totalCents - left[1].totalCents);
    categoryList.innerHTML = '';

    if (sortedExpenses.length === 0 && sortedIncome.length === 0) {
        categoryList.innerHTML = '<li class="cat-item">No transactions in this month.</li>';
        drawMonthlyPieChart([]);
        return;
    }

    const pieSlices = [
        ...sortedExpenses.map(([category, data], index) => ({
            label: category,
            value: data.totalCents,
            color: PIE_COLORS[index % PIE_COLORS.length]
        })),
        ...sortedIncome.map(([category, data]) => ({
            label: `${category} income`,
            value: data.totalCents,
            color: 'var(--income)'
        }))
    ];

    drawMonthlyPieChart(pieSlices);

    sortedExpenses.forEach(([category, data], index) => {
        categoryList.appendChild(buildSummaryCategoryItem({
            category,
            data,
            index,
            totalCents: expenseTotalCents,
            type: 'expense',
            color: PIE_COLORS[index % PIE_COLORS.length]
        }));
    });

    sortedIncome.forEach(([category, data], index) => {
        categoryList.appendChild(buildSummaryCategoryItem({
            category,
            data,
            index,
            totalCents: incomeTotalCents,
            type: 'income',
            color: 'var(--income)'
        }));
    });
}

function addSummaryBucket(buckets, transaction, amountCents) {
    const category = transaction.category || 'Other';
    const subCategory = transaction.subCategory || 'General';

    if (!buckets[category]) {
        buckets[category] = { totalCents: 0, subs: Object.create(null) };
    }

    buckets[category].totalCents += amountCents;
    buckets[category].subs[subCategory] = (buckets[category].subs[subCategory] || 0) + amountCents;
}

function getDisplayTransaction(transaction) {
    const category = CategoryService.sanitizeName(transaction.category) || 'Other';
    const subCategory = CategoryService.sanitizeName(transaction.subCategory) || 'General';
    const isGenericCategory = category === 'Other' && subCategory === 'General';

    if (!isGenericCategory || !transaction.name) {
        return { ...transaction, category, subCategory };
    }

    const guess = CategorizationEngine.categorize(transaction.name, transaction.type);
    if (!guess || !guess.c || guess.c === 'Other') {
        return { ...transaction, category, subCategory };
    }

    return {
        ...transaction,
        category: guess.c,
        subCategory: guess.s || CategoryService.getFirstSubOrDefault(guess.c)
    };
}

function buildSummaryCategoryItem({ category, data, index, totalCents, type, color }) {
    const item = document.createElement('li');
    item.className = `cat-item ${type === 'income' ? 'income-summary' : 'expense-summary'}`;
    item.dataset.category = category;
    item.dataset.type = type;
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    if (
        transactionCategoryFilter &&
        transactionCategoryFilter.category === category &&
        transactionCategoryFilter.month === currentMonthView &&
        transactionCategoryFilter.type === type
    ) {
        item.classList.add('active-filter');
    }

    const subBreakdown = Object.entries(data.subs)
        .sort((left, right) => right[1] - left[1])
        .map(([subCategory, amountCents]) => `
            <div class="sub-cat-chip">
                <span>${escapeHtml(subCategory)}</span>
                <span>${formatCents(amountCents)}</span>
            </div>
        `)
        .join('');
    const percentage = totalCents > 0 ? `${Math.round((data.totalCents / totalCents) * 100)}%` : '0%';
    const amountPrefix = type === 'income' ? '+' : '-';
    const typeLabel = type === 'income' ? 'Income' : percentage;

    item.innerHTML = `
        <div class="cat-row-main">
            <span class="category-pill"><span style="display:inline-block;width:12px;height:12px;border-radius:999px;background:${color};border:2px solid var(--line);"></span>${typeLabel}</span>
            <span class="cat-name">${escapeHtml(category)}</span>
            <span class="cat-val">${amountPrefix}${formatCents(data.totalCents)}</span>
        </div>
        <div class="cat-subs-list">${subBreakdown}</div>
    `;

    return item;
}

function toCents(amount) {
    return Math.round((Number(amount) || 0) * 100);
}

function formatCents(cents) {
    return `$${(Math.abs(Number(cents) || 0) / 100).toFixed(2)}`;
}

function getMonthKey(dateValue) {
    const value = String(dateValue || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.substring(0, 7) : '';
}

function formatMonthLabel(monthPrefix) {
    if (!monthPrefix || !monthPrefix.includes('-')) return 'All months';
    const [year, month] = monthPrefix.split('-');
    return new Date(Number(year), Number(month) - 1).toLocaleString('default', {
        month: 'short',
        year: 'numeric'
    });
}

function drawMonthlyPieChart(slices) {
    const canvas = document.getElementById('monthly-pie-chart');
    const emptyState = document.getElementById('chart-empty-state');
    const context = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = 92;

    context.clearRect(0, 0, width, height);
    context.fillStyle = '#fffdf8';
    context.strokeStyle = '#3a342d';
    context.lineWidth = 3;
    context.beginPath();
    context.arc(centerX, centerY, radius + 18, 0, Math.PI * 2);
    context.fill();
    context.stroke();

    if (!slices.length) {
        emptyState.classList.remove('hidden');
        context.fillStyle = '#5f584d';
        context.font = '20px "Patrick Hand"';
        context.textAlign = 'center';
        context.fillText('No expenses', centerX, centerY);
        return;
    }

    emptyState.classList.add('hidden');
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    let startAngle = -Math.PI / 2;

    slices.forEach(slice => {
        const sliceAngle = (slice.value / total) * Math.PI * 2;
        context.beginPath();
        context.moveTo(centerX, centerY);
        context.arc(centerX, centerY, radius, startAngle, startAngle + sliceAngle);
        context.closePath();
        context.fillStyle = slice.color;
        context.fill();
        context.stroke();
        startAngle += sliceAngle;
    });

    context.beginPath();
    context.fillStyle = '#fffaf2';
    context.arc(centerX, centerY, 36, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = '#22201b';
    context.font = '18px "Short Stack"';
    context.textAlign = 'center';
    context.fillText('Spend', centerX, centerY + 6);
}

function setupCategoryListeners() {
    document.getElementById('btn-add-primary').addEventListener('click', () => {
        const input = document.getElementById('new-primary-cat');
        const value = input.value.trim();
        if (!value) return;

        CategoryService.addPrimaryCategory(value);
        input.value = '';
        renderCategoryEditor();
        initializeManualForm();
    });

    document.getElementById('settings-tree-container').addEventListener('click', event => {
        const target = event.target;

        if (target.classList.contains('rename-primary-btn')) {
            const oldName = target.dataset.prim;
            const input = document.getElementById(`primary-name-${cssSafe(oldName)}`);
            const newName = input.value.trim();
            if (!newName) return;

            const renamed = CategoryService.renamePrimaryCategory(oldName, newName);
            if (renamed) {
                syncTransactionsAfterPrimaryRename(oldName, newName);
                renderAll();
            }
        }

        if (target.classList.contains('delete-primary-btn')) {
            const category = target.dataset.prim;
            if (confirm(`Delete "${category}"? Transactions in it will move to Other.`)) {
                CategoryService.deletePrimaryCategory(category);
                syncTransactionsAfterPrimaryDelete(category);
                renderAll();
            }
        }

        if (target.classList.contains('rename-sub-btn')) {
            const primary = target.dataset.prim;
            const oldSub = target.dataset.sub;
            const input = document.getElementById(`sub-name-${cssSafe(primary)}-${cssSafe(oldSub)}`);
            const newSub = input.value.trim();
            if (!newSub) return;

            const renamed = CategoryService.renameSubCategory(primary, oldSub, newSub);
            if (renamed) {
                syncTransactionsAfterSubcategoryRename(primary, oldSub, newSub);
                renderAll();
            }
        }

        if (target.classList.contains('delete-sub-btn')) {
            const primary = target.dataset.prim;
            const sub = target.dataset.sub;
            CategoryService.deleteSubCategory(primary, sub);
            syncTransactionsAfterSubcategoryDelete(primary, sub);
            renderAll();
        }

        if (target.classList.contains('add-sub-btn')) {
            const primary = target.dataset.prim;
            const input = document.getElementById(`new-sub-${cssSafe(primary)}`);
            const newSub = input.value.trim();
            if (!newSub) return;

            CategoryService.addSubCategory(primary, newSub);
            input.value = '';
            renderAll();
        }
    });
}

function renderCategoryEditor() {
    ensureSavedTransactionCategories();
    const container = document.getElementById('settings-tree-container');
    const tree = CategoryService.getTree();
    container.innerHTML = '';

    Object.entries(tree).forEach(([primary, subcategories]) => {
        const card = document.createElement('details');
        card.className = 'category-card';

        const subcategoryMarkup = subcategories.map(subcategory => `
            <div class="subcat-edit-row">
                <input
                    type="text"
                    id="sub-name-${cssSafe(primary)}-${cssSafe(subcategory)}"
                    class="form-input"
                    value="${escapeHtml(subcategory)}"
                >
                <button class="btn secondary mini-btn rename-sub-btn" data-prim="${escapeAttribute(primary)}" data-sub="${escapeAttribute(subcategory)}">Rename</button>
                <button class="btn danger mini-btn delete-sub-btn" data-prim="${escapeAttribute(primary)}" data-sub="${escapeAttribute(subcategory)}">Delete</button>
            </div>
        `).join('');

        card.innerHTML = `
            <summary>
                <div class="category-card-top">
                    <div>
                        <h3>${escapeHtml(primary)}</h3>
                        <p class="helper-text compact">${subcategories.length} subcategories</p>
                    </div>
                    <span class="count-pill">Edit</span>
                </div>
            </summary>
            <div class="category-card-body">
                <div class="category-name-row mt-2">
                    <input
                        type="text"
                        id="primary-name-${cssSafe(primary)}"
                        class="form-input"
                        value="${escapeHtml(primary)}"
                    >
                    <button class="btn secondary mini-btn rename-primary-btn" data-prim="${escapeAttribute(primary)}">Rename</button>
                    <button class="btn danger mini-btn delete-primary-btn" data-prim="${escapeAttribute(primary)}">Delete</button>
                </div>
                <div class="subcat-list">${subcategoryMarkup}</div>
                <div class="subcat-add-row">
                    <input type="text" class="form-input" placeholder="Add subcategory" id="new-sub-${cssSafe(primary)}">
                    <button class="btn primary mini-btn add-sub-btn" data-prim="${escapeAttribute(primary)}">Add</button>
                </div>
            </div>
        `;

        container.appendChild(card);
    });
}

function buildMobileScanHelp() {
    return 'No transactions were detected. Try a cleaner screenshot or a PDF with selectable text. If a date is missing, you can fill it in during review.';
}

function setupDataManagementListeners() {
    document.getElementById('export-backup').addEventListener('click', exportEncryptedBackup);
    document.getElementById('import-backup').addEventListener('click', () => {
        document.getElementById('backup-file-input').click();
    });
    document.getElementById('backup-file-input').addEventListener('change', async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        await importEncryptedBackup(file);
    });

    document.getElementById('clear-month-data').addEventListener('click', () => {
        const selectedMonth = document.getElementById('month-select')?.value || currentMonthView;
        if (!selectedMonth || selectedMonth === 'No data') return;

        if (!confirm(`Delete all transactions in ${selectedMonth}? Your customized categories and learning rules will stay saved.`)) return;

        const transactions = StorageService.getTransactions();
        const remaining = transactions.filter(transaction => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(transaction.date || '')) {
                return true;
            }
            return !transaction.date.startsWith(selectedMonth);
        });

        if (remaining.length === transactions.length) {
            alert('No transactions were found for that month.');
            return;
        }

        StorageService.replaceTransactions(remaining);
        currentMonthView = null;
        renderAll();
    });

    document.getElementById('clear-all-data').addEventListener('click', () => {
        if (!confirm('Delete every saved transaction? This cannot be undone. Rest assured, your customized categories and learning rules will NOT be deleted.')) return;
        StorageService.clearAll();
        renderAll();
    });
}

async function exportEncryptedBackup() {
    if (!window.crypto?.subtle) {
        alert('Encrypted backup needs a secure browser context. Try opening Spendlet over HTTPS.');
        return;
    }

    const password = promptForBackupPassword(true);
    if (!password) return;

    try {
        setBackupStatus('Creating encrypted backup...');
        const payload = buildBackupPayload();
        const encrypted = await encryptBackupPayload(payload, password);
        downloadBackupFile(encrypted);
        setBackupStatus('Encrypted backup downloaded.');
    } catch (error) {
        console.error(error);
        setBackupStatus('Could not create backup.');
        alert('Could not create the encrypted backup. Please try again.');
    }
}

async function importEncryptedBackup(file) {
    if (!window.crypto?.subtle) {
        alert('Encrypted import needs a secure browser context. Try opening Spendlet over HTTPS.');
        return;
    }

    const password = promptForBackupPassword(false);
    if (!password) return;

    try {
        setBackupStatus('Decrypting backup...');
        const encrypted = JSON.parse(await file.text());
        const payload = await decryptBackupPayload(encrypted, password);
        const importData = normalizeBackupPayload(payload);

        mergeBackupCategoryTree(importData.categoryTree);
        mergeBackupRules(importData.customRules);

        const importedTransactions = prepareBackupTransactionsForReview(importData.transactions);
        renderAll();

        if (importedTransactions.length === 0) {
            setBackupStatus('Backup opened. No transactions were found.');
            alert('Backup opened, but no transactions were found.');
            return;
        }

        const duplicateCount = Object.keys(detectDuplicateWarnings(importedTransactions)).length;
        document.querySelector('[data-target="import"]').click();
        showPreview(importedTransactions);
        setBackupStatus(`Backup opened: ${importedTransactions.length} transactions ready to review.`);
        alert(`Backup opened. ${importedTransactions.length} transactions are in Review.${duplicateCount ? ` ${duplicateCount} possible duplicates are marked.` : ''} Nothing was automatically deleted or skipped.`);
    } catch (error) {
        console.error(error);
        setBackupStatus('Could not import backup.');
        alert('Could not open this backup. Check the file and password.');
    }
}

function buildBackupPayload() {
    return {
        app: 'Spendlet',
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        transactions: StorageService.getTransactions(),
        categoryTree: CategoryService.getTree(),
        customRules: CategorizationEngine.getCustomRules()
    };
}

function normalizeBackupPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Backup payload is missing.');
    }

    return {
        transactions: Array.isArray(payload.transactions) ? payload.transactions : [],
        categoryTree: payload.categoryTree && typeof payload.categoryTree === 'object' ? payload.categoryTree : {},
        customRules: payload.customRules && typeof payload.customRules === 'object' ? payload.customRules : {}
    };
}

async function encryptBackupPayload(payload, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveBackupKey(password, salt);
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    const cipherText = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

    return {
        app: 'Spendlet',
        kind: 'encrypted-backup',
        version: BACKUP_VERSION,
        kdf: 'PBKDF2-SHA-256',
        iterations: BACKUP_KDF_ITERATIONS,
        cipher: 'AES-GCM',
        createdAt: new Date().toISOString(),
        salt: arrayBufferToBase64(salt),
        iv: arrayBufferToBase64(iv),
        data: arrayBufferToBase64(cipherText)
    };
}

async function decryptBackupPayload(encrypted, password) {
    if (!encrypted || encrypted.kind !== 'encrypted-backup' || !encrypted.salt || !encrypted.iv || !encrypted.data) {
        throw new Error('Not a Spendlet encrypted backup.');
    }

    const salt = base64ToUint8Array(encrypted.salt);
    const iv = base64ToUint8Array(encrypted.iv);
    const cipherText = base64ToUint8Array(encrypted.data);
    const key = await deriveBackupKey(password, salt, encrypted.iterations || BACKUP_KDF_ITERATIONS);
    const plainText = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherText);
    return JSON.parse(new TextDecoder().decode(plainText));
}

async function deriveBackupKey(password, salt, iterations = BACKUP_KDF_ITERATIONS) {
    const passwordKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveKey']
    );

    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        passwordKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

function mergeBackupCategoryTree(importedTree) {
    const currentTree = CategoryService.getTree();
    const mergedTree = { ...currentTree };

    Object.entries(importedTree || {}).forEach(([category, subcategories]) => {
        if (!Array.isArray(subcategories)) return;
        if (!mergedTree[category]) {
            mergedTree[category] = [];
        }

        subcategories.forEach(subcategory => {
            const cleanSubcategory = CategoryService.sanitizeName(subcategory);
            if (cleanSubcategory && !mergedTree[category].includes(cleanSubcategory)) {
                mergedTree[category].push(cleanSubcategory);
            }
        });

        if (mergedTree[category].length === 0) {
            mergedTree[category].push('General');
        }
    });

    CategoryService.saveTree(mergedTree);
}

function mergeBackupRules(importedRules) {
    const currentRules = CategorizationEngine.getCustomRules();
    CategorizationEngine.saveCustomRules({ ...currentRules, ...(importedRules || {}) });
}

function prepareBackupTransactionsForReview(transactions) {
    const currentIds = new Set(StorageService.getTransactions().map(transaction => transaction.id));

    return transactions.map(transaction => {
        const normalized = StorageService.normalizeTransaction(transaction);
        if (currentIds.has(normalized.id)) {
            delete normalized.id;
        }
        return normalized;
    });
}

function promptForBackupPassword(isExport) {
    const password = prompt(isExport ? 'Create a backup password. Spendlet cannot recover it if forgotten.' : 'Enter the backup password.');
    if (!password) return '';

    if (isExport) {
        const repeatedPassword = prompt('Type the backup password again.');
        if (password !== repeatedPassword) {
            alert('Backup passwords did not match.');
            return '';
        }
    }

    return password;
}

function downloadBackupFile(encryptedPayload) {
    const blob = new Blob([JSON.stringify(encryptedPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `spendlet-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function arrayBufferToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    bytes.forEach(byte => {
        binary += String.fromCharCode(byte);
    });
    return btoa(binary);
}

function base64ToUint8Array(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function setBackupStatus(message) {
    const status = document.getElementById('backup-status');
    status.textContent = message;
    status.classList.toggle('hidden', !message);
}

function syncTransactionsAfterPrimaryRename(oldName, newName) {
    const transactions = StorageService.getTransactions().map(transaction => {
        if (transaction.category !== oldName) return transaction;
        const selection = CategoryService.validateSelection(newName, transaction.subCategory);
        return { ...transaction, category: selection.category, subCategory: selection.subCategory };
    });
    StorageService.replaceTransactions(transactions);
}

function syncTransactionsAfterPrimaryDelete(category) {
    const transactions = StorageService.getTransactions().map(transaction => {
        if (transaction.category !== category) return transaction;
        const selection = CategoryService.validateSelection('Other', 'General');
        return { ...transaction, category: selection.category, subCategory: selection.subCategory };
    });
    StorageService.replaceTransactions(transactions);
}

function syncTransactionsAfterSubcategoryRename(primary, oldSub, newSub) {
    const transactions = StorageService.getTransactions().map(transaction => {
        if (transaction.category !== primary || transaction.subCategory !== oldSub) return transaction;
        const selection = CategoryService.validateSelection(primary, newSub);
        return { ...transaction, category: selection.category, subCategory: selection.subCategory };
    });
    StorageService.replaceTransactions(transactions);
}

function syncTransactionsAfterSubcategoryDelete(primary, subCategory) {
    const fallbackSub = CategoryService.getFirstSubOrDefault(primary);
    const transactions = StorageService.getTransactions().map(transaction => {
        if (transaction.category !== primary || transaction.subCategory !== subCategory) return transaction;
        const selection = CategoryService.validateSelection(primary, fallbackSub);
        return { ...transaction, category: selection.category, subCategory: selection.subCategory };
    });
    StorageService.replaceTransactions(transactions);
}

function populateCategorySelect(selectElement, selectedCategory) {
    const tree = CategoryService.getTree();
    const validCategory = tree[selectedCategory] ? selectedCategory : 'Other';
    selectElement.innerHTML = Object.keys(tree)
        .map(category => `<option value="${escapeAttribute(category)}" ${category === validCategory ? 'selected' : ''}>${escapeHtml(category)}</option>`)
        .join('');
}

function populateSubcategorySelect(selectElement, category, selectedSubcategory) {
    const tree = CategoryService.getTree();
    const validCategory = tree[category] ? category : 'Other';
    const subcategories = tree[validCategory] || ['General'];
    const validSub = subcategories.includes(selectedSubcategory) ? selectedSubcategory : subcategories[0];

    selectElement.innerHTML = subcategories
        .map(subcategory => `<option value="${escapeAttribute(subcategory)}" ${subcategory === validSub ? 'selected' : ''}>${escapeHtml(subcategory)}</option>`)
        .join('');
}

function cssSafe(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
    return escapeHtml(value);
}
