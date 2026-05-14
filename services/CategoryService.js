class CategoryService {
    static TREE_KEY = 'privacy_budget_category_tree';
    static DEFAULTS_MERGED_KEY = 'privacy_budget_default_categories_merged_v1';

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
        const stored = SpendletStorage.getItem(this.TREE_KEY);
        if (!stored) return this.cloneDefaultTree();

        let tree = null;
        try {
            tree = JSON.parse(stored);
        } catch (error) {
            console.warn('Saved category tree could not be read. Using defaults.', error);
            return this.cloneDefaultTree();
        }

        if (SpendletStorage.getItem(this.DEFAULTS_MERGED_KEY)) {
            return tree;
        }

        const mergedTree = this.mergeTrees(this.cloneDefaultTree(), tree);
        this.saveTree(mergedTree);
        return mergedTree;
    }

    static saveTree(tree) {
        SpendletStorage.setItem(this.TREE_KEY, JSON.stringify(tree));
        SpendletStorage.setItem(this.DEFAULTS_MERGED_KEY, 'true');
    }

    static mergeTrees(baseTree, incomingTree) {
        const merged = JSON.parse(JSON.stringify(baseTree || {}));

        Object.entries(incomingTree || {}).forEach(([category, subcategories]) => {
            const cleanCategory = this.sanitizeName(category);
            if (!cleanCategory) return;

            if (!merged[cleanCategory]) {
                merged[cleanCategory] = [];
            }

            (Array.isArray(subcategories) ? subcategories : []).forEach(subcategory => {
                const cleanSubcategory = this.sanitizeName(subcategory);
                if (cleanSubcategory && !merged[cleanCategory].includes(cleanSubcategory)) {
                    merged[cleanCategory].push(cleanSubcategory);
                }
            });

            if (merged[cleanCategory].length === 0) {
                merged[cleanCategory].push('General');
            }
        });

        return merged;
    }

    static getPrimaryCategories() {
        return Object.keys(this.getTree());
    }

    static sanitizeName(name) {
        return (name || '').trim().replace(/\s+/g, ' ');
    }

    static ensureCategory(catName) {
        const cleanName = this.sanitizeName(catName);
        if (!cleanName) return;

        const tree = this.getTree();
        if (!tree[cleanName]) {
            tree[cleanName] = ['General'];
            this.saveTree(tree);
        }
    }

    static ensureSelection(category, subCategory) {
        const cleanCategory = this.sanitizeName(category) || 'Other';
        const cleanSubCategory = this.sanitizeName(subCategory) || 'General';
        const tree = this.getTree();

        if (!tree[cleanCategory]) {
            tree[cleanCategory] = [];
        }

        if (!tree[cleanCategory].includes(cleanSubCategory)) {
            tree[cleanCategory].push(cleanSubCategory);
        }

        if (tree[cleanCategory].length === 0) {
            tree[cleanCategory].push('General');
        }

        this.saveTree(tree);
        return {
            category: cleanCategory,
            subCategory: cleanSubCategory
        };
    }

    static ensureSelectionsFromTransactions(transactions) {
        const tree = this.getTree();
        let changed = false;

        (transactions || []).forEach(transaction => {
            const category = this.sanitizeName(transaction.category) || 'Other';
            const subCategory = this.sanitizeName(transaction.subCategory) || 'General';

            if (!tree[category]) {
                tree[category] = [];
                changed = true;
            }

            if (!tree[category].includes(subCategory)) {
                tree[category].push(subCategory);
                changed = true;
            }
        });

        Object.keys(tree).forEach(category => {
            if (tree[category].length === 0) {
                tree[category].push('General');
                changed = true;
            }
        });

        if (changed) {
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
