class Scanner {
    static async processFiles(fileElement, statusCallback) {
        if (!fileElement.files || fileElement.files.length === 0) return [];

        const apiKey = localStorage.getItem('gemini_api_key');
        if (!apiKey) {
            return { error: 'Please set your Gemini API key in the Data & Settings panel.' };
        }

        let allTransactions = [];

        for (let i = 0; i < fileElement.files.length; i += 1) {
            const file = fileElement.files[i];
            statusCallback(\`Scanning file \${i + 1} of \${fileElement.files.length}...\`);

            try {
                if (!this.isSupportedFile(file)) {
                    statusCallback(\`File \${i + 1} is not a supported image or PDF file.\`);
                    continue;
                }

                const base64Data = await this.readFileAsBase64(file);
                const transactionsText = await this.callGeminiAPI(apiKey, file.type, base64Data, statusCallback);
                
                if (transactionsText) {
                    const parsed = this.parseResponse(transactionsText);
                    const processed = this.processTransactions(parsed);
                    allTransactions = allTransactions.concat(processed);
                }

            } catch (error) {
                console.error(error);
                statusCallback(\`Could not read file \${i + 1}. \${error.message}\`);
            }
        }

        return allTransactions;
    }

    static isSupportedFile(file) {
        const type = (file.type || '').toLowerCase();
        if (type.startsWith('image/') || type === 'application/pdf') return true;
        
        const name = (file.name || '').toLowerCase();
        return ['.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif', '.pdf'].some(ext => name.endsWith(ext));
    }

    static readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result;
                const base64Index = result.indexOf('base64,') + 7;
                resolve(result.substring(base64Index));
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    static async callGeminiAPI(apiKey, mimeType, base64Data, statusCallback) {
        const url = \`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=\${apiKey}\`;
        
        // Ensure proper mime type mappings
        let validMimeType = mimeType || 'image/jpeg';
        if (validMimeType === 'image/jpg') validMimeType = 'image/jpeg';
        
        const prompt = \`Extract the transaction details from this document.
Return ONLY a strictly valid JSON array of objects, with no markdown formatting and no backticks.
Each object must have the following keys:
- "date": Extract the transaction date in YYYY-MM-DD format. If missing, leave as an empty string. The user will be requested to review it.
- "name": The merchant or transaction name.
- "amount": The transaction amount as a positive number.
Do NOT include any other keys.
Do NOT capture non-transaction information or balances. Only return the individual itemized transactions if present, or the final charged amounts. If any field like date is missing, just leave it blank (e.g. "").\`;

        const requestBody = {
            contents: [{
                parts: [
                    { text: prompt },
                    {
                        inlineData: {
                            mimeType: validMimeType,
                            data: base64Data
                        }
                    }
                ]
            }],
            generationConfig: {
                temperature: 0.1,
                responseMimeType: "application/json"
            }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('API Error:', errorText);
            throw new Error('API Request Failed. Check your API key or network connection.');
        }

        const data = await response.json();
        
        if (data.candidates && data.candidates.length > 0 && data.candidates[0].content.parts.length > 0) {
            return data.candidates[0].content.parts[0].text;
        }
        
        return null;
    }

    static parseResponse(text) {
        try {
            // Strip any potential markdown formatting wrapping the JSON
            let cleanText = text.trim();
            if (cleanText.startsWith('\`\`\`json')) {
                cleanText = cleanText.substring(7);
            }
            if (cleanText.startsWith('\`\`\`')) {
                cleanText = cleanText.substring(3);
            }
            if (cleanText.endsWith('\`\`\`')) {
                cleanText = cleanText.substring(0, cleanText.length - 3);
            }
            
            return JSON.parse(cleanText);
        } catch (e) {
            console.error('Failed to parse Gemini response', text, e);
            return [];
        }
    }

    static processTransactions(parsedArray) {
        if (!Array.isArray(parsedArray)) return [];
        
        const transactions = [];
        
        parsedArray.forEach(item => {
            const amount = Math.abs(parseFloat(item.amount));
            if (isNaN(amount) || amount <= 0) return;
            
            const name = item.name ? String(item.name).trim() : 'Unknown Vendor';
            const date = item.date ? String(item.date).trim() : ''; // Intentionally leave blank for review if missing
            
            const categorized = CategorizationEngine.categorize(name, CategorizationEngine.guessType(name, amount));
            
            transactions.push({
                date: date,
                name: name,
                amount: amount,
                type: categorized.type,
                category: categorized.c,
                subCategory: categorized.s
            });
        });
        
        return transactions;
    }
}

window.Scanner = Scanner;
console.log('parsed ok')
