// ==UserScript==
// @name         Scanner Helper
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Helps identify the correct field for scanning and auto-sorts by time
// @author       You
// @match https://cohmis.clarityhs.com/passport
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================================
    // DEVICE CONFIGURATION - CHANGE THIS LINE FOR EACH DEVICE
    // ============================================================================
    const DINING_ROOM = "Food: Dining Room: Hot Meal";
    const TRAILER_PROTEIN = "Food: Trailer: Protein";
    const TRAILER_HOT_MEAL = "Food: Trailer: Hot Meal";

    const EXPECTED_SERVICE = DINING_ROOM;  // Change this for each device
    // Options: DINING_ROOM, TRAILER_PROTEIN, TRAILER_HOT_MEAL
    // ============================================================================

    console.log("Scanner Helper: Script loaded");

    let scannerActive = false;
    let overlay = null;
    let highlight = null;
    let serviceHighlight = null;
    let statusInterval = null;
    let sortInterval = null;

    // Multiple initialization attempts
    function forceInitialize() {
        console.log("Scanner Helper: Force initializing...");

        // Force create overlay immediately
        if (!overlay) {
            createOverlay();
        }

        // Force create highlight
        if (!highlight) {
            createHighlight();
        }

        // Force create service highlight
        if (!serviceHighlight) {
            createServiceHighlight();
        }

        // Start all functionality
        if (!scannerActive) {
            scannerActive = true;
            startStatusCheck();
            startCustomSort();
        }
    }

    function createOverlay() {
        console.log("Scanner Helper: Creating overlay");

        // Remove existing overlay if any
        const existing = document.getElementById('scanner-status-overlay');
        if (existing) existing.remove();

        overlay = document.createElement('div');
        overlay.id = 'scanner-status-overlay';
        overlay.style.cssText = `
            position: fixed !important;
            top: 20px !important;
            left: 50% !important;
            transform: translateX(-50%) !important;
            width: 320px !important;
            padding: 25px !important;
            background: white !important;
            border: 4px solid #ccc !important;
            border-radius: 15px !important;
            box-shadow: 0 0 25px rgba(0,0,0,0.6) !important;
            z-index: 999999 !important;
            font-family: Arial, sans-serif !important;
            font-size: 24px !important;
            font-weight: bold !important;
            text-align: center !important;
            cursor: default !important;
            display: block !important;
            visibility: visible !important;
        `;

        overlay.innerHTML = '<div style="margin-bottom: 10px;">⚠️</div><div style="font-size: 18px; line-height: 1.3;">Initializing...</div>';

        document.body.appendChild(overlay);

        console.log("Scanner Helper: Overlay created and added to page");
    }

    function createHighlight() {
        console.log("Scanner Helper: Creating highlight");

        // Remove existing highlight if any
        const existing = document.getElementById('field-highlight-helper');
        if (existing) existing.remove();

        highlight = document.createElement('div');
        highlight.id = 'field-highlight-helper';
        highlight.style.cssText = `
            position: absolute !important;
            border: 4px solid red !important;
            border-radius: 8px !important;
            background: rgba(255, 0, 0, 0.1) !important;
            pointer-events: none !important;
            z-index: 999998 !important;
            display: none !important;
            animation: pulse 1.5s infinite !important;
        `;

        // Add CSS animation
        if (!document.getElementById('scanner-pulse-style')) {
            const style = document.createElement('style');
            style.id = 'scanner-pulse-style';
            style.textContent = `
                @keyframes pulse {
                    0% { opacity: 0.3; transform: scale(1); }
                    50% { opacity: 0.8; transform: scale(1.05); }
                    100% { opacity: 0.3; transform: scale(1); }
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(highlight);
    }

    function createServiceHighlight() {
        console.log("Scanner Helper: Creating service highlight");

        // Remove existing service highlight if any
        const existing = document.getElementById('service-highlight-helper');
        if (existing) existing.remove();

        serviceHighlight = document.createElement('div');
        serviceHighlight.id = 'service-highlight-helper';
        serviceHighlight.style.cssText = `
            position: absolute !important;
            border: 4px solid red !important;
            border-radius: 8px !important;
            background: rgba(255, 0, 0, 0.1) !important;
            pointer-events: none !important;
            z-index: 999998 !important;
            display: none !important;
            animation: pulse 1.5s infinite !important;
        `;

        document.body.appendChild(serviceHighlight);
    }

    function deactivateScanner() {
        scannerActive = false;

        if (overlay) {
            overlay.remove();
            overlay = null;
        }

        if (highlight) {
            highlight.remove();
            highlight = null;
        }

        if (serviceHighlight) {
            serviceHighlight.remove();
            serviceHighlight = null;
        }

        if (statusInterval) {
            clearInterval(statusInterval);
            statusInterval = null;
        }

        if (sortInterval) {
            clearInterval(sortInterval);
            sortInterval = null;
        }
    }

    function checkServiceSelection() {
        const serviceDropdown = document.getElementById('service');
        if (!serviceDropdown) return { isCorrect: true, selectedText: 'Unknown' };

        const selectedOption = serviceDropdown.options[serviceDropdown.selectedIndex];
        const selectedText = selectedOption ? selectedOption.text : 'None';
        const isCorrect = selectedText === EXPECTED_SERVICE;

        return { isCorrect, selectedText };
    }

    function updateStatus() {
        if (!overlay) return;

        const activeElement = document.activeElement;
        const serviceCheck = checkServiceSelection();

        // Look for the unique identifier field in multiple ways
        const targetField = document.getElementById('uniqueId') ||
            document.querySelector('input[name="unique_identifier"]') ||
            document.querySelector('input[placeholder*="uid" i]') ||
            document.querySelector('input[name*="uid" i]') ||
            document.querySelector('input[id*="unique" i]') ||
            document.querySelector('input[type="text"]:focus');

        const isCorrectField = activeElement && targetField && activeElement === targetField;
        const anyInputFocused = activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA');

        // Check if service is incorrect first (highest priority)
        if (!serviceCheck.isCorrect) {
            overlay.style.background = '#f4d4d4';
            overlay.style.borderColor = '#f44336';
            overlay.style.color = '#C62828';
            overlay.innerHTML = '<div style="margin-bottom: 10px;">❌</div><div style="font-size: 16px; line-height: 1.3;">Wrong Service Selected!<br/>Change to:<br/><strong>' + EXPECTED_SERVICE + '</strong></div>';

            // Highlight the service dropdown
            const serviceDropdown = document.getElementById('service');
            if (serviceDropdown && serviceHighlight) {
                highlightElement(serviceDropdown, serviceHighlight);
            }

            // Hide field highlight
            if (highlight) highlight.style.display = 'none';
        }
        // Then check field selection
        else if (isCorrectField || anyInputFocused) {
            overlay.style.background = '#d4f4d4';
            overlay.style.borderColor = '#4CAF50';
            overlay.style.color = '#2E7D32';
            overlay.innerHTML = '<div style="margin-bottom: 10px;">✅</div><div>Ready To Scan</div>';
            if (highlight) highlight.style.display = 'none';
            if (serviceHighlight) serviceHighlight.style.display = 'none';
        } else {
            overlay.style.background = '#f4d4d4';
            overlay.style.borderColor = '#f44336';
            overlay.style.color = '#C62828';
            overlay.innerHTML = '<div style="margin-bottom: 10px;">⚠️</div><div style="font-size: 18px; line-height: 1.3;">Tap Glowing Box to Right of<br/>"Unique Identifier"</div>';

            if (targetField && highlight) {
                highlightElement(targetField, highlight);
            }
            if (serviceHighlight) serviceHighlight.style.display = 'none';
        }
    }

    function highlightElement(element, highlightDiv) {
        if (!element || !highlightDiv) return;

        const rect = element.getBoundingClientRect();
        highlightDiv.style.display = 'block';
        highlightDiv.style.left = (rect.left + window.scrollX - 6) + 'px';
        highlightDiv.style.top = (rect.top + window.scrollY - 6) + 'px';
        highlightDiv.style.width = (rect.width + 12) + 'px';
        highlightDiv.style.height = (rect.height + 12) + 'px';
    }

    function highlightField(element) {
        highlightElement(element, highlight);
    }

    function makeDraggable(element) {
        let isDragging = false;
        let dragOffset = { x: 0, y: 0 };

        element.addEventListener('mousedown', function (e) {
            if (e.target.innerHTML === '×') return;
            isDragging = true;
            dragOffset.x = e.clientX - element.offsetLeft;
            dragOffset.y = e.clientY - element.offsetTop;
            element.style.cursor = 'grabbing';
        });

        document.addEventListener('mousemove', function (e) {
            if (isDragging) {
                element.style.left = (e.clientX - dragOffset.x) + 'px';
                element.style.top = (e.clientY - dragOffset.y) + 'px';
                element.style.right = 'auto';
            }
        });

        document.addEventListener('mouseup', function () {
            isDragging = false;
            if (element) element.style.cursor = 'move';
        });
    }

    function startStatusCheck() {
        console.log("Scanner Helper: Starting status check");
        updateStatus();
        statusInterval = setInterval(updateStatus, 500);
    }

    // CUSTOM SORT FUNCTIONALITY - actually sort the DOM elements
    function startCustomSort() {
        console.log("Scanner Helper: Starting custom sort");

        // Try to sort immediately
        setTimeout(attemptCustomSort, 2000);

        // Then check periodically for new content
        sortInterval = setInterval(attemptCustomSort, 5000);
    }

    function attemptCustomSort() {
        try {
            const tables = document.querySelectorAll('table');

            tables.forEach((table, tableIndex) => {
                const headers = table.querySelectorAll('th');
                let timeColumnIndex = -1;

                // Find time/date column
                headers.forEach((header, index) => {
                    const headerText = header.textContent.toLowerCase().trim();

                    if (headerText.includes('time') || headerText.includes('date') ||
                        headerText.includes('created') || headerText.includes('updated') ||
                        headerText.includes('timestamp')) {
                        timeColumnIndex = index;
                        console.log(`Scanner Helper: Found time column at index ${index}`);
                    }
                });

                if (timeColumnIndex >= 0) {
                    sortTableByTimeColumn(table, timeColumnIndex);
                }
            });

        } catch (error) {
            console.log('Scanner Helper: Custom sort failed:', error);
        }
    }

    function sortTableByTimeColumn(table, columnIndex) {
        try {
            const tbody = table.querySelector('tbody') || table;
            const rows = Array.from(tbody.querySelectorAll('tr')).filter(row => {
                return row.cells && row.cells.length > columnIndex;
            });

            if (rows.length < 2) {
                return;
            }

            // Remove header row if it exists
            const headerRow = table.querySelector('thead tr') ||
                             (rows[0].cells[0].tagName.toLowerCase() === 'th' ? rows.shift() : null);

            // Sort rows by time column
            rows.sort((a, b) => {
                const timeA = a.cells[columnIndex]?.textContent.trim() || '';
                const timeB = b.cells[columnIndex]?.textContent.trim() || '';

                // Parse times like "04:41 PM" - need to add today's date for proper parsing
                const today = new Date().toDateString();
                const dateA = new Date(`${today} ${timeA}`);
                const dateB = new Date(`${today} ${timeB}`);

                if (!isNaN(dateA) && !isNaN(dateB)) {
                    return dateB - dateA; // Most recent first (later times at top)
                }

                // Fallback to string comparison (reverse for newest first)
                return timeA.localeCompare(timeB);
            });

            // Remove all rows from table
            rows.forEach(row => row.remove());

            // Add them back in sorted order
            rows.forEach(row => tbody.appendChild(row));

            console.log("Scanner Helper: Table sorted successfully");

        } catch (error) {
            console.log('Scanner Helper: Table sort failed:', error);
        }
    }

    // Add CSS for better styling
    (function addCustomCSS() {
        const style = document.createElement('style');
        style.textContent = `
            .scanner-helper-highlight {
                background-color: yellow !important;
                border: 2px solid orange !important;
            }
        `;
        document.head.appendChild(style);
    })();

    // INITIALIZATION
    console.log("Scanner Helper: Setting up initialization");

    forceInitialize();

})();
