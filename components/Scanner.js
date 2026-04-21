import CategorizationEngine from '../services/CategorizationEngine.js';

export default class Scanner {
    
    // Process text line by line to discover transactions
    static parseText(rawText) {
        const lines = rawText.split('\n').filter(line => line.trim().length > 0);
        const transactions = [];

        // Basic Regex setups
        const amountRegex = /[\+\-]?\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})/;
        const dateRegex = /\b(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|[A-Za-z]{3}\s\d{1,2})\b/;

        lines.forEach(line => {
            const amountMatch = line.match(amountRegex);
            
            // If there's an amount, let's treat it as a potential transaction
            if (amountMatch) {
                let amountStr = amountMatch[0].replace(/[$\s,]/g, '');
                let amount = parseFloat(amountStr);
                
                // Usually banks label credits vs debits, but without strict schema, we make best guess.
                // Normally an amount without a minus is an expense in credit card statements, but let's just 
                // categorize "payment" or negative as income, and positive as expense for standard simple logic.
                // We'll set absolute value here, type will be expense unless we see "Payment" or "+"
                let type = 'expense';
                if (line.toLowerCase().includes('payment') || amountStr.includes('+') || line.includes('Deposit')) {
                    type = 'income';
                }
                amount = Math.abs(amount);

                // Date logic
                let dateMatch = line.match(dateRegex);
                let dateStr = new Date().toISOString().split('T')[0]; // Default today
                if (dateMatch) {
                    // Try to parse the date safely
                    let parsedDate = new Date(dateMatch[0]);
                    if (!isNaN(parsedDate.getTime())) {
                        dateStr = parsedDate.toISOString().split('T')[0];
                    }
                }

                // Name is line minus amount and date
                let name = line.replace(amountMatch[0], '').replace(dateMatch ? dateMatch[0] : '', '').trim();
                // Clean up remaining noise
                name = name.replace(/^[-\s|]+|[-\s|]+$/g, '').trim();
                if (!name) name = "Unknown Vendor";

                transactions.push({
                    date: dateStr,
                    name: name,
                    amount: amount,
                    type: type,
                    category: CategorizationEngine.categorize(name)
                });
            }
        });

        return transactions;
    }

    static async processImage(fileElement, statusCallback) {
        if (!fileElement.files || fileElement.files.length === 0) return [];
        const file = fileElement.files[0];
        
        statusCallback("Initializing local AI...");
        try {
            // Using the globally loaded Tesseract from the CDN in index.html
            const result = await Tesseract.recognize(file, 'eng', {
                logger: m => {
                    if (m.status === 'recognizing text') {
                        statusCallback(`Scanning... ${Math.round(m.progress * 100)}%`);
                    }
                }
            });
            statusCallback("Parsing results...");
            return this.parseText(result.data.text);
        } catch (error) {
            console.error(error);
            statusCallback("Error reading image. Please try again.");
            return [];
        }
    }
}
