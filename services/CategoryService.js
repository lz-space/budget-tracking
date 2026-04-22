class CategoryService {
    static TREE_KEY = 'privacy_budget_category_tree';

    static defaultTree = {
        'Transport': ['Gas', 'Parking', 'Transit', 'Rideshare', 'Car Care', 'Other'],
        'Food & Drink': ['Groceries', 'Restaurants', 'Coffee', 'Delivery', 'Snacks', 'Other'],
        'Shopping': ['Clothing', 'Electronics', 'Home', 'Beauty', 'Gifts', 'Other'],
        'Housing': ['Rent/Mortgage', 'Utilities', 'Maintenance', 'Insurance', 'Supplies', 'Other'],
        'Entertainment': ['Subscriptions', 'Movies', 'Games', 'Events', 'Hobbies', 'Other'],
        'Health': ['Pharmacy', 'Doctor', 'Fitness', 'Insurance', 'Wellness', 'Other'],
        'Bills': ['Phone', 'Internet', 'Software', 'Bank Fees', 'Other'],
        'Income': ['Salary', 'Bonus', 'Refund', 'Transfer In', 'Gift', 'Other'],
        'Other': ['General']
    };

    static cloneDefaultTree() {
        return JSON.parse(JSON.stringify(this.defaultTree));
    }

    static getTree() {
        const stored = localStorage.getItem(this.TREE_KEY);
        return stored ? JSON.parse(stored) : this.cloneDefaultTree();
    }

    static saveTree(tree) {
        localStorage.setItem(this.TREE_KEY, JSON.stringify(tree));
    }

    static getPrimaryCategories() {
        return Object.keys(this.getTree());
    }

    static sanitizeName(name) {
        return (name || '').trim().replace(/\s+/g, ' ');
    }

    static ensureCategory(catName) {
        const tree = this.getTree();
        if (!tree[catName]) {
            tree[catName] = ['General'];
            this.saveTree(tree);
        }
    }

    static addPrimaryCategory(catName) {
        const cleanName = this.sanitizeName(catName);
        if (!cleanName) return false;

        const tree = this.getTree();
        if (tree[cleanName]) return false;
        tree[cleanName] = ['General'];
        this.saveTree(tree);
        return true;
    }

    static renamePrimaryCategory(oldName, newName) {
        const cleanName = this.sanitizeName(newName);
        const tree = this.getTree();

        if (!tree[oldName] || !cleanName || (tree[cleanName] && cleanName !== oldName)) {
            return false;
        }

        tree[cleanName] = tree[oldName];
        if (cleanName !== oldName) {
            delete tree[oldName];
        }
        this.saveTree(tree);
        return true;
    }

    static deletePrimaryCategory(catName) {
        const tree = this.getTree();
        if (!tree[catName]) return false;
        delete tree[catName];
        if (!tree.Other) {
            tree.Other = ['General'];
        }
        this.saveTree(tree);
        return true;
    }

    static addSubCategory(catName, subName) {
        const cleanName = this.sanitizeName(subName);
        const tree = this.getTree();
        if (!tree[catName] || !cleanName || tree[catName].includes(cleanName)) return false;
        tree[catName].push(cleanName);
        this.saveTree(tree);
        return true;
    }

    static renameSubCategory(catName, oldName, newName) {
        const cleanName = this.sanitizeName(newName);
        const tree = this.getTree();
        if (!tree[catName] || !cleanName) return false;

        const index = tree[catName].indexOf(oldName);
        if (index === -1) return false;
        if (tree[catName].includes(cleanName) && cleanName !== oldName) return false;

        tree[catName][index] = cleanName;
        this.saveTree(tree);
        return true;
    }

    static deleteSubCategory(catName, subName) {
        const tree = this.getTree();
        if (!tree[catName]) return false;

        tree[catName] = tree[catName].filter(sub => sub !== subName);
        if (tree[catName].length === 0) {
            tree[catName].push('General');
        }
        this.saveTree(tree);
        return true;
    }

    static getFirstSubOrDefault(catName) {
        const tree = this.getTree();
        if (tree[catName] && tree[catName].length > 0) {
            return tree[catName][0];
        }
        return 'General';
    }

    static validateSelection(category, subCategory) {
        const tree = this.getTree();
        const validCategory = tree[category] ? category : 'Other';
        const subcategories = tree[validCategory] || ['General'];
        const validSubCategory = subcategories.includes(subCategory) ? subCategory : subcategories[0];

        return {
            category: validCategory,
            subCategory: validSubCategory
        };
    }
}

window.CategoryService = CategoryService;
