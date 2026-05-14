const SpendletStorage = (() => {
    const memoryStore = new Map();
    let storageChecked = false;
    let nativeStorage = null;

    function getNativeStorage() {
        if (storageChecked) return nativeStorage;
        storageChecked = true;

        try {
            const storage = window.localStorage;
            const testKey = '__spendlet_storage_test__';
            storage.setItem(testKey, '1');
            storage.removeItem(testKey);
            nativeStorage = storage;
        } catch (error) {
            nativeStorage = null;
            console.warn('Persistent browser storage is unavailable. Spendlet will use temporary in-memory storage for this page.', error);
        }

        return nativeStorage;
    }

    return {
        getItem(key) {
            const storage = getNativeStorage();
            if (storage) {
                try {
                    return storage.getItem(key);
                } catch (error) {
                    console.warn(`Could not read ${key} from browser storage.`, error);
                }
            }

            return memoryStore.has(key) ? memoryStore.get(key) : null;
        },

        setItem(key, value) {
            const stringValue = String(value);
            const storage = getNativeStorage();
            if (storage) {
                try {
                    storage.setItem(key, stringValue);
                    return;
                } catch (error) {
                    console.warn(`Could not write ${key} to browser storage.`, error);
                }
            }

            memoryStore.set(key, stringValue);
        },

        removeItem(key) {
            const storage = getNativeStorage();
            if (storage) {
                try {
                    storage.removeItem(key);
                } catch (error) {
                    console.warn(`Could not remove ${key} from browser storage.`, error);
                }
            }

            memoryStore.delete(key);
        },

        isPersistent() {
            return Boolean(getNativeStorage());
        }
    };
})();

window.SpendletStorage = SpendletStorage;
