class StorageService {
    static STORAGE_KEY = 'privacy_budget_txs';

    static getTransactions() {
        const data = SpendletStorage.getItem(this.STORAGE_KEY);
        if (!data) return [];

        let parsed = [];
        try {
            parsed = JSON.parse(data);
        } catch (error) {
            console.warn('Saved transactions could not be read. Starting with an empty list.', error);
            parsed = [];
        }

        const txs = (Array.isArray(parsed) ? parsed : []).map(tx => this.normalizeTransaction(tx));
        return txs.sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    static normalizeTransaction(tx) {
        const normalized = {
            id: tx.id || this.generateId(),
            date: this.normalizeDate(tx.date),
            name: (tx.name || 'Unknown Vendor').trim(),
            amount: Math.abs(Number(tx.amount) || 0),
            type: tx.type === 'income' ? 'income' : 'expense'
        };

        normalized.category = CategoryService.sanitizeName(tx.category) || 'Other';
        normalized.subCategory = CategoryService.sanitizeName(tx.subCategory) || 'General';
        if (normalized.category === 'Income') {
            normalized.type = 'income';
        }
        return normalized;
    }

    static normalizeDate(dateValue) {
        if (!dateValue) {
            return new Date().toISOString().split('T')[0];
        }

        if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
            return dateValue;
        }

        const parsed = new Date(dateValue);
        if (Number.isNaN(parsed.getTime())) {
            return new Date().toISOString().split('T')[0];
        }

        const year = parsed.getFullYear();
        const month = String(parsed.getMonth() + 1).padStart(2, '0');
        const day = String(parsed.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    static saveTransaction(tx) {
        const txs = this.getTransactions();
        const next = this.normalizeTransaction(tx);
        next.id = tx.id || this.generateId();
        txs.push(next);
        this.replaceTransactions(txs);
        return next;
    }

    static saveMultipleTransactions(newTxs) {
        const txs = this.getTransactions();
        const normalized = newTxs.map(tx => {
            const next = this.normalizeTransaction(tx);
            next.id = tx.id || this.generateId();
            return next;
        });
        this.replaceTransactions([...txs, ...normalized]);
        return normalized;
    }

    static updateTransaction(updatedTx) {
        const txs = this.getTransactions();
        const next = this.normalizeTransaction(updatedTx);
        next.id = updatedTx.id;
        const updated = txs.map(tx => tx.id === updatedTx.id ? next : tx);
        this.replaceTransactions(updated);
        return next;
    }

    static replaceTransactions(transactions) {
        const normalized = transactions.map(tx => this.normalizeTransaction(tx));
        SpendletStorage.setItem(this.STORAGE_KEY, JSON.stringify(normalized));
    }

    static deleteTransaction(id) {
        const txs = this.getTransactions().filter(tx => tx.id !== id);
        this.replaceTransactions(txs);
    }

    static clearAll() {
        SpendletStorage.removeItem(this.STORAGE_KEY);
    }

    static generateId() {
        return `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    }
}

window.StorageService = StorageService;
