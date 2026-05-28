import { db } from './firebase-config.js';
import { doc, getDoc, setDoc, updateDoc, increment } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

async function trackVisit() {
    // Get current date in YYYY-MM-DD format based on local timezone
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const today = `${year}-${month}-${day}`; 

    const statsRef = doc(db, 'stats', 'pageViews');

    const dailyEl = document.getElementById('daily-views');
    const totalEl = document.getElementById('total-views');
    
    // For manual resetting purpose. Remove this block after deployment.
    // await setDoc(statsRef, { totalViews: 0, dailyViews: 0, lastUpdateDate: today });
    
    try {
        const docSnap = await getDoc(statsRef);
        let data = docSnap.exists() ? docSnap.data() : null;
        
        // Use sessionStorage so we don't count reloads as new visits
        const hasVisited = sessionStorage.getItem('eden_visited');
        
        if (data && data.totalViews > 60000) { data.totalViews = 0; data.dailyViews = 0; data.lastUpdateDate = today; await setDoc(statsRef, data); }
        if (!data) {
            // Initialize with the hardcoded starting numbers
            data = {
                totalViews: 0,
                dailyViews: 0,
                lastUpdateDate: today
            };
            await setDoc(statsRef, data);
        }

        if (!hasVisited) {
            // New visit!
            sessionStorage.setItem('eden_visited', 'true');
            
            if (data.lastUpdateDate !== today) {
                // New day! Reset daily counter
                data.dailyViews = 1;
                data.totalViews += 1;
                data.lastUpdateDate = today;
                await setDoc(statsRef, data); 
            } else {
                // Same day, use atomic increment
                data.dailyViews += 1;
                data.totalViews += 1;
                await updateDoc(statsRef, {
                    dailyViews: increment(1),
                    totalViews: increment(1)
                });
            }
        } else {
            // Has visited already in this session
            // Just display the current numbers. If the day changed but nobody else visited, show 0.
            if (data.lastUpdateDate !== today) {
                data.dailyViews = 0;
            }
        }
        
        // Update the UI
        if (dailyEl) dailyEl.innerText = data.dailyViews.toLocaleString('en-US');
        if (totalEl) totalEl.innerText = data.totalViews.toLocaleString('en-US');

    } catch (e) {
        console.error("Failed to load counter:", e);
    }
}

document.addEventListener('DOMContentLoaded', trackVisit);

