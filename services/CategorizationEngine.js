class CategorizationEngine {
    static CUSTOM_RULES_KEY = 'privacy_budget_cat_rules';

    static baseRules = [
        { keywords: ['uber eats', 'doordash', 'door dash', 'grubhub', 'postmates'], category: 'Food & Drink', subCategory: 'Delivery' },
        { keywords: ['whole foods', 'trader joe', 'trader joes', 'costco', 'aldi', 'kroger', 'publix', 'safeway', 'instacart'], category: 'Food & Drink', subCategory: 'Groceries' },
        { keywords: ['starbucks', 'dunkin', 'blue bottle', 'cafe', 'coffee'], category: 'Food & Drink', subCategory: 'Coffee' },
        { keywords: ['restaurant', 'diner', 'chipotle', 'sweetgreen', 'mcdonald', 'shake shack', 'taco bell'], category: 'Food & Drink', subCategory: 'Restaurants' },
        { keywords: ['uber', 'lyft', 'taxi', 'rideshare'], category: 'Transport', subCategory: 'Rideshare' },
        { keywords: ['shell', 'chevron', 'exxon', 'mobil', 'bp ', 'gas station', 'fuel'], category: 'Transport', subCategory: 'Gas' },
        { keywords: ['parking', 'garage', 'meter'], category: 'Transport', subCategory: 'Parking' },
        { keywords: ['mta', 'subway', 'trainline', 'amtrak', 'metro', 'bus'], category: 'Transport', subCategory: 'Transit' },
        { keywords: ['amazon', 'target', 'walmart'], category: 'Shopping', subCategory: 'Home' },
        { keywords: ['apple', 'best buy', 'micro center'], category: 'Shopping', subCategory: 'Electronics' },
        { keywords: ['sephora', 'ulta'], category: 'Shopping', subCategory: 'Beauty' },
        { keywords: ['zara', 'uniqlo', 'h&m', 'nike', 'marshalls', 'tj maxx'], category: 'Shopping', subCategory: 'Clothing' },
        { keywords: ['rent', 'mortgage'], category: 'Housing', subCategory: 'Rent/Mortgage' },
        { keywords: ['electric', 'utility', 'coned', 'pge', 'water bill'], category: 'Housing', subCategory: 'Utilities' },
        { keywords: ['ikea', 'home depot', 'lowes'], category: 'Housing', subCategory: 'Supplies' },
        { keywords: ['spotify', 'netflix', 'hulu', 'disney', 'youtube premium'], category: 'Entertainment', subCategory: 'Subscriptions' },
        { keywords: ['steam', 'playstation', 'nintendo', 'xbox'], category: 'Entertainment', subCategory: 'Games' },
        { keywords: ['cinema', 'movie', 'ticketmaster'], category: 'Entertainment', subCategory: 'Events' },
        { keywords: ['cvs', 'walgreens', 'rite aid', 'pharmacy'], category: 'Health', subCategory: 'Pharmacy' },
        { keywords: ['doctor', 'clinic', 'medical', 'dentist', 'hospital'], category: 'Health', subCategory: 'Doctor' },
        { keywords: ['planet fitness', 'equinox', 'ymca', 'gym'], category: 'Health', subCategory: 'Fitness' },
        { keywords: ['verizon', 'att', 'tmobile', 'mint mobile'], category: 'Bills', subCategory: 'Phone' },
        { keywords: ['comcast', 'xfinity', 'spectrum', 'internet'], category: 'Bills', subCategory: 'Internet' },
        { keywords: ['dropbox', 'openai', 'figma', 'notion', 'icloud'], category: 'Bills', subCategory: 'Software' },
        { keywords: ['atm fee', 'service fee', 'maintenance fee'], category: 'Bills', subCategory: 'Bank Fees' },
        { keywords: ['payroll', 'salary', 'direct deposit', 'paycheck'], category: 'Income', subCategory: 'Salary', type: 'income' },
        { keywords: ['bonus'], category: 'Income', subCategory: 'Bonus', type: 'income' },
        { keywords: ['refund', 'reversal'], category: 'Income', subCategory: 'Refund', type: 'income' },
        { keywords: ['zelle', 'venmo cashout', 'transfer from'], category: 'Income', subCategory: 'Transfer In', type: 'income' }
    ];

    static getCustomRules() {
        const rules = localStorage.getItem(this.CUSTOM_RULES_KEY);
        return rules ? JSON.parse(rules) : {};
    }

    static saveCustomRules(rules) {
        localStorage.setItem(this.CUSTOM_RULES_KEY, JSON.stringify(rules));
    }

    static normalizeName(name) {
        return (name || '')
            .toLowerCase()
            .replace(/[*#]/g, ' ')
            .replace(/\b(pending|debit|credit|purchase|pos|card|visa|mastercard|online|transfer|ach|check|payment|posted|contactless)\b/g, ' ')
            .replace(/\d{2,}/g, ' ')
            .replace(/[^a-z\s&]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    static buildNameVariants(name) {
        const normalized = this.normalizeName(name);
        const words = normalized.split(' ').filter(Boolean);
        const variants = new Set();

        if (normalized) {
            variants.add(normalized);
        }

        if (words.length >= 1) {
            variants.add(words[0]);
        }

        if (words.length >= 2) {
            variants.add(words.slice(0, 2).join(' '));
        }

        if (words.length >= 3) {
            variants.add(words.slice(0, 3).join(' '));
        }

        words.forEach(word => {
            if (word.length >= 4) {
                variants.add(word);
            }
        });

        return {
            normalized,
            variants: [...variants].filter(variant => variant.length >= 3)
        };
    }

    static learnMapping(name, category, subCategory) {
        if (!name || !category || category === 'Other') return;

        const selection = CategoryService.validateSelection(category, subCategory);
        const rules = this.getCustomRules();
        const details = this.buildNameVariants(name);

        details.variants.forEach(variant => {
            rules[variant] = {
                category: selection.category,
                subCategory: selection.subCategory,
                learnedFrom: details.normalized
            };
        });

        this.saveCustomRules(rules);
    }

    static guessType(name, amountText = '') {
        const normalized = this.normalizeName(name);
        const incomeHints = ['payroll', 'salary', 'deposit', 'refund', 'reversal', 'bonus', 'interest', 'cashback'];
        if (incomeHints.some(hint => normalized.includes(hint))) return 'income';
        if (String(amountText).trim().startsWith('+')) return 'income';
        return 'expense';
    }

    static findCustomRule(name) {
        const details = this.buildNameVariants(name);
        const customRules = this.getCustomRules();
        let bestMatch = null;

        Object.entries(customRules).forEach(([key, mapping]) => {
            if (!details.normalized.includes(key) && !key.includes(details.normalized)) {
                return;
            }

            const score = key.length + (mapping.learnedFrom === details.normalized ? 40 : 0);
            if (!bestMatch || score > bestMatch.score) {
                bestMatch = {
                    score,
                    category: mapping.category,
                    subCategory: mapping.subCategory
                };
            }
        });

        return bestMatch;
    }

    static categorize(name, preferredType = null) {
        const fallback = CategoryService.validateSelection('Other', 'General');
        if (!name) {
            return { c: fallback.category, s: fallback.subCategory, type: preferredType || 'expense' };
        }

        const details = this.buildNameVariants(name);
        let bestMatch = this.findCustomRule(name);

        this.baseRules.forEach(rule => {
            rule.keywords.forEach(keyword => {
                if (details.normalized.includes(keyword)) {
                    const score = keyword.length;
                    if (!bestMatch || score > bestMatch.score) {
                        bestMatch = {
                            score,
                            category: rule.category,
                            subCategory: rule.subCategory,
                            type: rule.type
                        };
                    }
                }
            });
        });

        if (!bestMatch) {
            const inferredType = preferredType || this.guessType(name);
            if (inferredType === 'income') {
                const validIncome = CategoryService.validateSelection('Income', 'Other');
                return { c: validIncome.category, s: validIncome.subCategory, type: 'income' };
            }

            return { c: fallback.category, s: fallback.subCategory, type: inferredType };
        }

        const selection = CategoryService.validateSelection(bestMatch.category, bestMatch.subCategory);
        return {
            c: selection.category,
            s: selection.subCategory,
            type: bestMatch.type || preferredType || this.guessType(name)
        };
    }
}

window.CategorizationEngine = CategorizationEngine;
