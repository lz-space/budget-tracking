let pendingTransactions = [];
let editingTransactionId = null;
let currentMonthView = null;
let transactionSearchTerm = '';

const PIE_COLORS = ['#d67b44', '#2d7a53', '#5d8db8', '#b2574f', '#8c6db4', '#d1a84a', '#72825e', '#d98080'];

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

    toggleButton.addEventListener('click', () => {
        const isCollapsed = panelBody.classList.toggle('collapsed');
        toggleButton.textContent = isCollapsed ? 'Expand' : 'Collapse';
        toggleButton.setAttribute('aria-expanded', String(!isCollapsed));
    });
}

function renderAll() {
    renderOverview();
    renderCategoryEditor();
    initializeManualForm();
    refreshPendingPreviewCategories();
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

    fileInput.addEventListener('change', async () => {
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
        if (transactions.length === 0) {
            helpBox.textContent = buildMobileScanHelp();
            helpBox.classList.remove('hidden');
        } else if (transactions.error) {
            helpBox.textContent = transactions.error;
            helpBox.classList.remove('hidden');
            return;
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

        const reviewedTransactions = Array.from(rows).map(row => {
            const index = Number(row.dataset.index);
            const dateInput = row.querySelector('.tx-edit-date');
            if (!dateInput.value) {
                hasMissingFields = true;
                dateInput.style.border = '2px solid red';
            } else {
                dateInput.style.border = '';
            }
            return buildTransactionFromRow(row, pendingTransactions[index] || {});
        });

        if (hasMissingFields) {
            alert('Please review and fill in all missing transaction details (highlighted in red) before saving.');
            return;
        }

        StorageService.saveMultipleTransactions(reviewedTransactions);
        pendingTransactions = [];
        document.getElementById('import-preview-area').classList.add('hidden');
        document.querySelector('[data-target="overview"]').click();
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
        subCategory: selection.subCategory
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
        const row = document.createElement('div');
        row.className = 'editable-tx-row';
        row.dataset.index = String(index);
        row.innerHTML = `
            <div class="preview-row-head">
                <div class="preview-hints">
                    ${hint ? `<span class="duplicate-pill ${hint.level}">${escapeHtml(hint.label)}</span>` : ''}
                </div>
                <button class="btn danger mini-btn remove-preview-btn" type="button" data-index="${index}">Remove</button>
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

function detectDuplicateWarnings(transactions) {
    const savedTransactions = StorageService.getTransactions();
    const warnings = {};

    transactions.forEach((transaction, index) => {
        const normalizedName = normalizeDuplicateName(transaction.name);
        const intraMatch = transactions.find((other, otherIndex) => {
            if (index === otherIndex) return false;
            return isPotentialDuplicate(transaction, normalizedName, other, normalizeDuplicateName(other.name));
        });

        if (intraMatch) {
            warnings[index] = {
                level: 'strong',
                label: 'Possible duplicate',
                message: `This looks very close to another scanned row: ${intraMatch.name} for $${intraMatch.amount.toFixed(2)} on ${intraMatch.date}. Remove one if they are the same purchase.`
            };
            return;
        }

        const savedMatch = savedTransactions.find(saved => {
            return isPotentialDuplicate(transaction, normalizedName, saved, normalizeDuplicateName(saved.name));
        });

        if (savedMatch) {
            warnings[index] = {
                level: 'soft',
                label: 'Already saved?',
                message: `A similar saved transaction already exists: ${savedMatch.name} for $${savedMatch.amount.toFixed(2)} on ${savedMatch.date}.`
            };
        }
    });

    return warnings;
}

function isPotentialDuplicate(left, leftName, right, rightName) {
    if (left.type !== right.type) return false;

    const sameAmount = Math.abs((left.amount || 0) - (right.amount || 0)) < 0.01;
    const closeDate = Math.abs(new Date(left.date).getTime() - new Date(right.date).getTime()) <= 2 * 24 * 60 * 60 * 1000;
    const strongNameMatch = leftName && rightName && (leftName === rightName || leftName.includes(rightName) || rightName.includes(leftName));
    const looseNameMatch = leftName && rightName && levenshteinDistance(leftName, rightName) <= 2;

    return sameAmount && closeDate && (strongNameMatch || looseNameMatch);
}

function normalizeDuplicateName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\b(inc|llc|co|corp|payment|purchase|debit|credit)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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
    const transactions = StorageService.getTransactions();

    list.innerHTML = '';

    const totalBalance = transactions.reduce((sum, transaction) => {
        return sum + (transaction.type === 'income' ? transaction.amount : -transaction.amount);
    }, 0);

    balanceElement.textContent = `${totalBalance < 0 ? '-' : ''}$${Math.abs(totalBalance).toFixed(2)}`;
    balanceElement.className = `summary-amount ${totalBalance >= 0 ? 'positive' : 'negative'}`;

    const filteredTransactions = transactions.filter(transaction => {
        if (!transactionSearchTerm) return true;
        const haystack = `${transaction.name} ${transaction.category} ${transaction.subCategory}`.toLowerCase();
        return haystack.includes(transactionSearchTerm);
    });

    countElement.textContent = `${filteredTransactions.length} shown`;

    if (filteredTransactions.length === 0) {
        list.innerHTML = `<li class="tx-item"><div class="tx-left"><span class="tx-name">${transactions.length ? 'No matches' : 'No transactions yet'}</span><span class="tx-date">${transactions.length ? 'Try a different search.' : 'Go to Add to scan or enter your first transaction.'}</span></div></li>`;
        if (!transactions.length) {
            balanceElement.textContent = '$0.00';
            balanceElement.className = 'summary-amount';
        }
        return;
    }

    filteredTransactions.forEach(transaction => {
        const item = document.createElement('li');
        item.className = 'tx-item';
        item.innerHTML = `
            <div class="tx-left">
                <span class="tx-name">${escapeHtml(transaction.name)}</span>
                <span class="tx-date">${transaction.date}</span>
                <span class="tx-cat">${escapeHtml(transaction.category)} / ${escapeHtml(transaction.subCategory)}</span>
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
    const months = [...new Set(transactions.map(transaction => transaction.date.substring(0, 7)))].sort().reverse();

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

    monthSelect.onchange = () => updateMonthlyBreakdown(transactions, monthSelect.value);
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
    const monthTransactions = transactions.filter(transaction => transaction.date.startsWith(monthPrefix));
    let incomeTotal = 0;
    let expenseTotal = 0;
    const categoryBuckets = {};

    monthTransactions.forEach(transaction => {
        if (transaction.type === 'income') {
            incomeTotal += transaction.amount;
            return;
        }

        expenseTotal += transaction.amount;
        if (!categoryBuckets[transaction.category]) {
            categoryBuckets[transaction.category] = { total: 0, subs: {} };
        }
        categoryBuckets[transaction.category].total += transaction.amount;
        categoryBuckets[transaction.category].subs[transaction.subCategory] =
            (categoryBuckets[transaction.category].subs[transaction.subCategory] || 0) + transaction.amount;
    });

    document.getElementById('month-income').textContent = `+$${incomeTotal.toFixed(2)}`;
    document.getElementById('month-expense').textContent = `-$${expenseTotal.toFixed(2)}`;

    const net = incomeTotal - expenseTotal;
    const netElement = document.getElementById('month-net');
    netElement.textContent = `${net < 0 ? '-' : '+'}$${Math.abs(net).toFixed(2)}`;
    netElement.style.color = net >= 0 ? 'var(--income)' : 'var(--expense)';

    const sortedCategories = Object.entries(categoryBuckets).sort((left, right) => right[1].total - left[1].total);
    categoryList.innerHTML = '';

    if (sortedCategories.length === 0) {
        categoryList.innerHTML = '<li class="cat-item">No expenses in this month.</li>';
        drawMonthlyPieChart([]);
        return;
    }

    drawMonthlyPieChart(sortedCategories.map(([category, data], index) => ({
        label: category,
        value: data.total,
        color: PIE_COLORS[index % PIE_COLORS.length]
    })));

    sortedCategories.forEach(([category, data], index) => {
        const item = document.createElement('li');
        item.className = 'cat-item';

        const subBreakdown = Object.entries(data.subs)
            .sort((left, right) => right[1] - left[1])
            .map(([subCategory, amount]) => `
                <div class="sub-cat-chip">
                    <span>${escapeHtml(subCategory)}</span>
                    <span>$${amount.toFixed(2)}</span>
                </div>
            `)
            .join('');

        item.innerHTML = `
            <div class="cat-row-main">
                <span class="category-pill"><span style="display:inline-block;width:12px;height:12px;border-radius:999px;background:${PIE_COLORS[index % PIE_COLORS.length]};border:2px solid var(--line);"></span>${((data.total / expenseTotal) * 100).toFixed(0)}%</span>
                <span class="cat-name">${escapeHtml(category)}</span>
                <span class="cat-val">-$${data.total.toFixed(2)}</span>
            </div>
            <div class="cat-subs-list">${subBreakdown}</div>
        `;

        categoryList.appendChild(item);
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
