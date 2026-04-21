export default class StorageService {
    static STORAGE_KEY = 'privacy_budget_txs';

    static getTransactions() {
        const data = localStorage.getItem(this.STORAGE_KEY);
        if (!data) return [];
        return JSON.parse(data).sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    static saveTransaction(tx) {
        const txs = this.getTransactions();
        // Give unique ID based on timestamp
        tx.id = Date.now().toString() + Math.floor(Math.random() * 1000);
        txs.push(tx);
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(txs));
    }

    static saveMultipleTransactions(newTxs) {
        const txs = this.getTransactions();
        newTxs.forEach(tx => {
            tx.id = Date.now().toString() + Math.floor(Math.random() * 1000);
            txs.push(tx);
        });
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(txs));
    }

    static deleteTransaction(id) {
        let txs = this.getTransactions();
        txs = txs.filter(t => t.id !== id);
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(txs));
    }

    static clearAll() {
        localStorage.removeItem(this.STORAGE_KEY);
    }
}
