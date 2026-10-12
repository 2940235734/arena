document.getElementById('open').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
document.getElementById('quick').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html?run=1') });
