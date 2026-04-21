export default class CategorizationEngine {
    static ruleMapping = {
        'uber': 'Transport',
        'lyft': 'Transport',
        'subway': 'Transport',
        'mta': 'Transport',
        'starbucks': 'Food & Drink',
        'dunkin': 'Food & Drink',
        'mcdonalds': 'Food & Drink',
        'restaurant': 'Food & Drink',
        'amazon': 'Shopping',
        'target': 'Groceries',
        'walmart': 'Groceries',
        'whole foods': 'Groceries',
        'trader joe': 'Groceries',
        'netflix': 'Entertainment',
        'spotify': 'Entertainment',
        'apple': 'Electronics'
    };

    static categorize(name) {
        if (!name) return 'Other';
        const lowerName = name.toLowerCase();
        
        for (const [key, category] of Object.entries(this.ruleMapping)) {
            if (lowerName.includes(key)) {
                return category;
            }
        }
        return 'Other'; 
    }
}
