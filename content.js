chrome.runtime.onMessage.addListener(async (message) => {
    if (message.action === "imagePiP") {

        const img = document.createElement('img')
        img.src = message.imgUrl

        const stylesheet = document.createElement('style')
        stylesheet.innerHTML = `
        *{margin:0;padding:0;box-sizing:border-box;background:black;}
        img{width:100%}
        `

        const pipWindow = await documentPictureInPicture.requestWindow()
        pipWindow.document.head.append(stylesheet)
        pipWindow.document.body.append(img)
    }
})