chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "imagePiP",
        title: "Open in PiP Window",
        contexts: ["image"]
    })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "imagePiP" && tab?.id) {
        chrome.tabs.sendMessage(tab.id, {
            action: "imagePiP",
            imgUrl: info.srcUrl,
        }, { frameId: 0 }).catch(error => {
            console.error("Failed to send message:", error)
        })
    }
})