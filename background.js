chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "imagePiP",
        title: "Open in PiP Window",
        contexts: ["image"]
    })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "imagePiP") {
        chrome.tabs.sendMessage(tab.id, {
            action: "imagePiP",
            imgUrl: info.srcUrl
        })
    }
})