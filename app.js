import StorageService from './services/StorageService.js';
import Scanner from './components/Scanner.js';

let pendingTransactions = [];
let editingTransactionId = null;

// Derived list of common categories 
const CATEGORIES = [
    'Transport', 'Food & Drink', 'Shopping', 'Groceries', 
    'Entertainment', 'Electronics', 'Housing', 'Health', 'Other'
];

document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

function initApp() {
    setupTabs();
    setupScannerListeners();
    setupModalListeners();
    renderDashboard();
    renderMonthlySummary();
}

/* UI Tabs Logic */
function setupTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    const sections = document.querySelectorAll('.view-section');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            sections.forEach(s => s.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.target).classList.add('active');
            
            if (tab.dataset.target === 'dashboard') renderDashboard();
            if (tab.dataset.target === 'summary') renderMonthlySummary();
        });
    });
}

function generateCategoryOptions(selectedCat) {
    return CATEGORIES.map(c => `<option value="${c}" ${c === selectedCat ? 'selected' : ''}>${c}</option>`).join('');
}

/* Scanner & Paste Integration */
function setupScannerListeners() {
    const fileInput = document.getElementById('file-input');
    const statusMsg = document.getElementById('ocr-status');
    const pasteBtn = document.getElementById('process-paste-btn');
    const pasteArea = document.getElementById('smart-paste-input');

    fileInput.addEventListener('change', async () => {
        statusMsg.classList.remove('hidden');
        const txs = await Scanner.processImages(fileInput, (msg) => { statusMsg.textContent = msg; });
        statusMsg.classList.add('hidden');
        showPreview(txs);
        fileInput.value = ''; 
    });

    pasteBtn.addEventListener('click', () => {
        const text = pasteArea.value;
        if (!text.trim()) return;
        const txs = Scanner.parseText(text);
        showPreview(txs);
        pasteArea.value = ''; 
    });

    document.getElementById('cancel-import').addEventListener('click', () => {
        document.getElementById('import-preview-area').classList.add('hidden');
        pendingTransactions = [];
    });

    document.getElementById('save-import').addEventListener('click', () => {
        // Collect edits from the UI
        const rows = document.querySelectorAll('.editable-tx-row');
        pendingTransactions = Array.from(rows).map((row, idx) => {
            return {
                id: pendingTransactions[idx]?.id || Date.now() + idx,
                date: row.querySelector('.tx-edit-date').value,
                name: row.querySelector('.tx-edit-name').value,
                amount: parseFloat(row.querySelector('.tx-edit-amount').value) || 0,
                type: row.querySelector('.tx-edit-type').value,
                category: row.querySelector('.tx-edit-category').value,
            };
        });

        StorageService.saveMultipleTransactions(pendingTransactions);
        document.getElementById('import-preview-area').classList.add('hidden');
        pendingTransactions = [];
        document.querySelector('[data-target="dashboard"]').click();
    });
}

/* Edit Modal Integration */
function setupModalListeners() {
    const modal = document.getElementById('edit-modal');
    
    // Setup category dropdown in modal
    const catSelect = document.getElementById('edit-category');
    catSelect.innerHTML = generateCategoryOptions('Other');

    document.getElementById('cancel-edit').addEventListener('click', () => {
        modal.classList.add('hidden');
        editingTransactionId = null;
    });

    document.getElementById('save-edit').addEventListener('click', () => {
        if (!editingTransactionId) return;
        
        let txs = StorageService.getTransactions();
        const txIndex = txs.findIndex(t => t.id === editingTransactionId);
        if (txIndex !== -1) {
            txs[txIndex] = {
                id: editingTransactionId,
                date: document.getElementById('edit-date').value,
                name: document.getElementById('edit-name').value,
                amount: parseFloat(document.getElementById('edit-amount').value) || 0,
                category: document.getElementById('edit-category').value,
                type: document.getElementById('edit-type').value
            };
            // Replace full list
            StorageService.clearAll();
            txs.forEach(t => StorageService.saveTransaction(t));
        }
        
        modal.classList.add('hidden');
        editingTransactionId = null;
        renderDashboard();
    });

    document.getElementById('delete-edit').addEventListener('click', () => {
        if (!editingTransactionId) return;
        StorageService.deleteTransaction(editingTransactionId);
        modal.classList.add('hidden');
        editingTransactionId = null;
        renderDashboard();
    });
}

function openEditModal(tx) {
    editingTransactionId = tx.id;
    document.getElementById('edit-date').value = tx.date;
    document.getElementById('edit-name').value = tx.name;
    document.getElementById('edit-amount').value = tx.amount;
    document.getElementById('edit-category').innerHTML = generateCategoryOptions(tx.category);
    document.getElementById('edit-type').value = tx.type;
    
    document.getElementById('edit-modal').classList.remove('hidden');
}


/* Preview Scanned Items (Editable UI) */
function showPreview(txs) {
    const previewList = document.getElementById('preview-list');
    const previewArea = document.getElementById('import-preview-area');
    
    if (txs.length === 0) {
        alert("We couldn't detect any transactions from this data. Please try again.");
        return;
    }

    pendingTransactions = txs;
    previewList.innerHTML = '';
    
    txs.forEach((tx) => {
        const div = document.createElement('div');
        div.className = 'editable-tx-row';
        div.innerHTML = `
            <div class="inline-row">
                <input type="date" value="${tx.date}" class="form-input tx-edit-date">
                <input type="text" value="${tx.name}" class="form-input tx-edit-name">
            </div>
            <div class="inline-row">
                <input type="number" step="0.01" value="${tx.amount.toFixed(2)}" class="form-input tx-edit-amount">
                <select class="form-input tx-edit-type">
                    <option value="expense" ${tx.type === 'expense' ? 'selected' : ''}>Expense</option>
                    <option value="income" ${tx.type === 'income' ? 'selected' : ''}>Income</option>
                </select>
            </div>
            <select class="form-input tx-edit-category">
                ${generateCategoryOptions(tx.category)}
            </select>
        `;
        previewList.appendChild(div);
    });

    previewArea.classList.remove('hidden');
}


/* Dashboard Render */
function renderDashboard() {
    const list = document.getElementById('transaction-list');
    const balanceElem = document.getElementById('total-balance');
    const txs = StorageService.getTransactions();

    list.innerHTML = '';
    let totalBalance = 0;

    if (txs.length === 0) {
        list.innerHTML = '<p class="sub-text" style="text-align: center;">No transactions yet. Head to Scanner to import data.</p>';
        balanceElem.textContent = '$0.00';
        return;
    }

    txs.forEach(tx => {
        if (tx.type === 'income') totalBalance += tx.amount;
        else totalBalance -= tx.amount;

        const li = document.createElement('li');
        li.className = 'tx-item';
        li.innerHTML = `
            <div class="tx-left">
                <span class="tx-name">${tx.name}</span>
                <span class="tx-date">${tx.date}</span>
                <span class="tx-cat">${tx.category}</span>
            </div>
            <div class="tx-amount ${tx.type}">${tx.type === 'income' ? '+' : '-'}$${tx.amount.toFixed(2)}</div>
        `;
        
        li.addEventListener('click', () => openEditModal(tx));
        list.appendChild(li);
    });

    balanceElem.textContent = `$${Math.abs(totalBalance).toFixed(2)}`;
    balanceElem.className = `summary-amount ${totalBalance >= 0 ? 'positive' : 'negative'}`;
}

/* Monthly Summary Render */
function renderMonthlySummary() {
    const txs = StorageService.getTransactions();
    const select = document.getElementById('month-select');
    
    const months = [...new Set(txs.map(t => t.date.substring(0, 7)))].sort().reverse();
    
    if (months.length === 0) {
        select.innerHTML = '<option>No Data Available</option>';
        updateMonthlyBreakdown([], null);
        return;
    }

    let selectedMonth = select.value;
    select.innerHTML = '';
    months.forEach(m => {
        const option = document.createElement('option');
        option.value = m;
        
        const [yy, mm] = m.split('-');
        const dateObj = new Date(yy, parseInt(mm)-1);
        option.textContent = dateObj.toLocaleString('default', { month: 'long', year: 'numeric' });
        
        if (m === selectedMonth) option.selected = true;
        select.appendChild(option);
    });

    if (!months.includes(selectedMonth)) selectedMonth = months[0];

    select.onchange = () => updateMonthlyBreakdown(txs, select.value);
    updateMonthlyBreakdown(txs, selectedMonth);
}

function updateMonthlyBreakdown(txs, monthPrefix) {
    if (!monthPrefix) return;
    
    const monthTxs = txs.filter(t => t.date.startsWith(monthPrefix));
    
    let inc = 0, exp = 0;
    const catBuckets = {};

    monthTxs.forEach(tx => {
        if (tx.type === 'income') {
            inc += tx.amount;
        } else {
            exp += tx.amount;
            catBuckets[tx.category] = (catBuckets[tx.category] || 0) + tx.amount;
        }
    });

    document.getElementById('month-income').textContent = `+$${inc.toFixed(2)}`;
    document.getElementById('month-expense').textContent = `-$${exp.toFixed(2)}`;
    const netElem = document.getElementById('month-net');
    const net = inc - exp;
    netElem.textContent = `${net >= 0 ? '+' : '-'}$${Math.abs(net).toFixed(2)}`;
    netElem.style.color = net >= 0 ? 'var(--income)' : 'var(--expense)';

    const catList = document.getElementById('category-summary-list');
    catList.innerHTML = '';
    
    const sortedCats = Object.entries(catBuckets).sort((a,b) => b[1] - a[1]);
    if (sortedCats.length === 0) {
        catList.innerHTML = '<span class="sub-text">No expenses this month.</span>';
    }

    sortedCats.forEach(([cat, amount]) => {
        const li = document.createElement('li');
        li.className = 'cat-item';
        li.innerHTML = `
            <span class="cat-name">${cat}</span>
            <span class="cat-val">-$${amount.toFixed(2)}</span>
        `;
        catList.appendChild(li);
    });
}
