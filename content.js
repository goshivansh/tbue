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

// Vide Utilities

const SPEED_STEP = 0.25;
const MIN_SPEED = 0.25;
const MAX_SPEED = 8.00;

const VOLUME_STEP = 0.10;      // 10% per press
const MIN_VOLUME = 0.00;       // 0%
const MAX_VOLUME = 5.00;       // 500%

// Approximate frame duration used for frame-stepping. There is no
// reliable, universal way to read a video's true frame rate across
// sites/codecs, so 30fps is used as a reasonable default.
const FRAME_TIME = 1 / 30;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

// ==============================
// Video registry
// ==============================
//
// Instead of re-scanning the entire DOM (including shadow roots) on
// every keypress, we maintain a live registry of known <video>
// elements. It's populated once up front and then kept up to date
// incrementally via MutationObservers, which is far cheaper on
// DOM-heavy pages.

const knownVideos = new Set();
const trackedElements = new WeakSet();
const scannedShadowRoots = new WeakSet();
const scannedIframeDocs = new WeakSet();

let lastActiveVideo = null;

function trackVideo(video) {
    if (trackedElements.has(video)) return;
    trackedElements.add(video);
    knownVideos.add(video);

    // Remember whichever video the user actually clicked/tapped on,
    // so getActiveVideo() can prefer it as a tiebreaker over pure
    // visible-area heuristics (helps with grids of thumbnails /
    // previews where several videos are simultaneously visible).
    //
    // Deliberately NOT listening for "play" here: sites like
    // YouTube autoplay small preview clips on hover (related-video
    // thumbnails, home page grid), and those fire "play" without
    // any real click. Tracking that would silently steal focus
    // away from the video you're actually watching.
    video.addEventListener("pointerdown", () => { lastActiveVideo = video; }, true);

    // Note: deliberately NOT listening for "emptied" here. SPAs
    // like YouTube fire it whenever a new source loads into the
    // *same, still-connected* <video> element (switching videos,
    // autoplay advancing to the next one) - deregistering on that
    // event would drop a perfectly valid, still-present video from
    // the registry, with no DOM mutation left to trigger
    // rediscovery. Real removal is handled below via removedNodes.
}

function untrackVideo(video) {
    knownVideos.delete(video);
    trackedElements.delete(video);
    if (lastActiveVideo === video) lastActiveVideo = null;
}

function scanRemovedNode(node) {
    if (!node || node.nodeType !== 1) return;

    if (node instanceof HTMLVideoElement) {
        untrackVideo(node);
        return;
    }

    if (node.querySelectorAll) {
        for (const video of node.querySelectorAll("video")) {
            untrackVideo(video);
        }
    }
}

function scanNode(node) {
    if (!node) return;

    if (node instanceof HTMLVideoElement) {
        trackVideo(node);
        return;
    }

    if (!node.querySelectorAll) return;

    for (const video of node.querySelectorAll("video")) {
        trackVideo(video);
    }

    for (const element of node.querySelectorAll("*")) {
        if (element.shadowRoot && !scannedShadowRoots.has(element.shadowRoot)) {
            scannedShadowRoots.add(element.shadowRoot);
            scanNode(element.shadowRoot);
            observeRoot(element.shadowRoot);
        }

        if (element.tagName === "IFRAME") {
            tryScanIframe(element);
        }
    }
}

function tryScanIframe(iframe) {
    // Same-origin iframes only. Cross-origin iframes throw on
    // contentDocument access and can't be reached from here - but
    // since the manifest injects this script into every frame
    // (all_frames: true), a cross-origin iframe gets its own
    // independent copy of this script, which handles shortcuts
    // whenever that frame itself has keyboard focus.
    try {
        const doc = iframe.contentDocument;
        if (!doc || scannedIframeDocs.has(doc)) return;

        const scanWhenReady = () => {
            if (scannedIframeDocs.has(doc)) return;
            scannedIframeDocs.add(doc);
            scanNode(doc);
            if (doc.documentElement) observeRoot(doc.documentElement);
        };

        if (doc.readyState === "loading") {
            iframe.addEventListener("load", scanWhenReady, { once: true });
        } else {
            scanWhenReady();
        }
    } catch {
        // Cross-origin - nothing we can do from the parent frame.
    }
}

function observeRoot(root) {
    try {
        const obs = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach(scanNode);
                mutation.removedNodes.forEach(scanRemovedNode);
            }
        });
        obs.observe(root, { childList: true, subtree: true });
    } catch {
        // Some roots (e.g. closed shadow roots) can't be observed - skip.
    }
}

function initRegistry() {
    if (!document.documentElement) return;
    scanNode(document);
    observeRoot(document.documentElement);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initRegistry, { once: true });
} else {
    initRegistry();
}
// Safety net in case document_start ran before <html> existed.
window.addEventListener("load", () => scanNode(document), { once: true });

// Entering fullscreen - however it was triggered, whether our own
// shortcut or the site's native fullscreen button - is about as
// strong a signal as it gets for "this is the video I'm watching".
document.addEventListener("fullscreenchange", () => {
    const el = document.fullscreenElement;
    if (el instanceof HTMLVideoElement) lastActiveVideo = el;
});

// ==============================
// Determine the active video
// ==============================

function getAllVideos() {
    // Cheap defensive rescan: a plain, non-recursive query for
    // <video> tags in the light DOM. This is a safety net alongside
    // the mutation-based registry above - if some site's DOM
    // choreography ever manages to dodge the MutationObserver, a
    // fresh video is still picked up the next time a shortcut is
    // pressed, at negligible cost (it doesn't descend into shadow
    // roots or iframes - the registry already covers those).
    for (const video of document.querySelectorAll("video")) {
        trackVideo(video);
    }

    return [...knownVideos].filter(video => video.isConnected);
}

function getVisibleArea(video) {
    const rect = video.getBoundingClientRect();

    if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.bottom <= 0 ||
        rect.right <= 0 ||
        rect.top >= window.innerHeight ||
        rect.left >= window.innerWidth
    ) {
        return 0;
    }

    const visibleWidth = Math.min(rect.right, window.innerWidth)
        - Math.max(rect.left, 0);

    const visibleHeight = Math.min(rect.bottom, window.innerHeight)
        - Math.max(rect.top, 0);

    return Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
}

function getActiveVideo() {
    const videos = getAllVideos();
    if (!videos.length) return null;

    const playing = videos.filter(video =>
        !video.paused && !video.ended && video.readyState >= 2
    );

    const visiblePool = (playing.length ? playing : videos)
        .filter(video => getVisibleArea(video) > 0);

    const candidates = visiblePool.length ? visiblePool : (playing.length ? playing : videos);

    // Prefer the last video the user actually interacted with, as
    // long as it's still a reasonable candidate.
    if (lastActiveVideo && candidates.includes(lastActiveVideo)) {
        return lastActiveVideo;
    }

    if (candidates.length === 1) return candidates[0];

    return candidates
        .map(video => ({ video, area: getVisibleArea(video) }))
        .sort((a, b) => b.area - a.area)[0].video;
}

// Resolves the active video and, on success, "sticks" lastActiveVideo
// to it - so once a shortcut has acted on a video, subsequent
// shortcuts keep targeting that same video even if something else
// (an autoplaying thumbnail elsewhere on the page) is also playing.
function withActiveVideo(action) {
    const video = getActiveVideo();
    if (!video) return showMessage("No video found");
    lastActiveVideo = video;
    return action(video);
}

// ==============================
// Speed handling
// ==============================

function setSpeed(video, speed) {
    if (!video) return;
    speed = Math.round(clamp(speed, MIN_SPEED, MAX_SPEED) * 100) / 100;
    video.playbackRate = speed;
    showSpeed(speed);
}

function changeSpeed(amount) {
    withActiveVideo(video => setSpeed(video, (video.playbackRate || 1) + amount));
}

function resetSpeed() {
    withActiveVideo(video => setSpeed(video, 1));
}

function formatSpeed(speed) {
    return Number.isInteger(speed)
        ? speed.toString()
        : speed.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

// ==============================
// Volume boost (Web Audio gain)
// ==============================
//
// video.volume tops out at 1.0 (100%). To go beyond that we route
// the element's audio through a GainNode. This is created lazily
// (only on first boost attempt) and cached per-video, since a
// MediaElementSourceNode can only ever be created once for a given
// <video> element.
//
// Known limitation: on cross-origin video without permissive CORS
// headers, browsers may silently mute audio once it's routed
// through a Web Audio graph. That's a browser security restriction,
// not something fixable from here.

const audioGraphs = new WeakMap();

function getOrCreateAudioGraph(video) {
    if (audioGraphs.has(video)) return audioGraphs.get(video);

    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        const source = ctx.createMediaElementSource(video);
        const gain = ctx.createGain();
        gain.gain.value = 1;
        source.connect(gain).connect(ctx.destination);

        const graph = { ctx, gain, value: 1 };
        audioGraphs.set(video, graph);
        return graph;
    } catch {
        return null;
    }
}

function changeVolumeBoost(amount) {
    withActiveVideo(video => {
        const graph = getOrCreateAudioGraph(video);
        if (!graph) return showMessage("Volume boost unavailable");

        if (graph.ctx.state === "suspended") graph.ctx.resume();

        graph.value = Math.round(clamp(graph.value + amount, MIN_VOLUME, MAX_VOLUME) * 100) / 100;
        graph.gain.gain.value = graph.value;
        showMessage(`Volume ${Math.round(graph.value * 100)}%`);
    });
}

function resetVolumeBoost() {
    withActiveVideo(video => {
        const graph = getOrCreateAudioGraph(video);
        if (!graph) return showMessage("Volume boost unavailable");

        graph.value = 1;
        graph.gain.gain.value = 1;
        showMessage("Volume 100%");
    });
}

function toggleMute() {
    withActiveVideo(video => {
        video.muted = !video.muted;
        showMessage(video.muted ? "Muted" : "Unmuted");
    });
}

// ==============================
// Fullscreen
// ==============================

function toggleFullscreen() {
    withActiveVideo(async video => {
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
                showMessage("Exited fullscreen");
            } else if (video.requestFullscreen) {
                await video.requestFullscreen();
                showMessage("Fullscreen");
            } else {
                showMessage("Fullscreen unavailable");
            }
        } catch {
            showMessage("Fullscreen unavailable");
        }
    });
}

// ==============================
// Frame stepping
// ==============================

function stepFrame(direction) {
    const video = getActiveVideo();
    if (!video) return showMessage("No video found");

    if (!video.paused) video.pause();

    const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = clamp(video.currentTime + direction * FRAME_TIME, 0, duration);

    showMessage(`Frame ${direction > 0 ? "\u25b6" : "\u25c0"} ${video.currentTime.toFixed(2)}s`);
}

// ==============================
// On-screen indicator
// ==============================

let indicatorTimer = null;

function getIndicator() {
    let indicator = document.getElementById("__universal_video_speed_indicator");

    if (!indicator) {
        indicator = document.createElement("div");
        indicator.id = "__universal_video_speed_indicator";

        Object.assign(indicator.style, {
            position: "fixed",
            top: "20px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: "2147483647",
            background: "rgba(0, 0, 0, 0.75)",
            color: "#fff",
            padding: "8px 12px",
            borderRadius: "6px",
            fontFamily: "Arial, sans-serif",
            fontSize: "16px",
            fontWeight: "bold",
            lineHeight: "1",
            pointerEvents: "none",
            opacity: "0",
            transition: "opacity 0.15s ease",
            boxSizing: "border-box"
        });

        (document.documentElement || document.body).appendChild(indicator);
    }

    return indicator;
}

function showIndicatorText(text) {
    const indicator = getIndicator();
    indicator.textContent = text;
    indicator.style.opacity = "1";

    clearTimeout(indicatorTimer);
    indicatorTimer = setTimeout(() => {
        indicator.style.opacity = "0";
    }, 900);
}

function showSpeed(speed) {
    showIndicatorText(`${formatSpeed(speed)}\u00d7`);
}

function showMessage(message) {
    showIndicatorText(message);
}

// ==============================
// Keyboard controls
// ==============================

function isEditableTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return !!el.isContentEditable;
}

window.addEventListener("keydown", event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (isEditableTarget(event.target)) return;

    let handled = true;

    if (event.shiftKey) {
        switch (event.code) {
            case "Period": changeSpeed(SPEED_STEP); break;
            case "Comma": changeSpeed(-SPEED_STEP); break;
            case "Digit0": resetSpeed(); break;
            case "ArrowUp": changeVolumeBoost(VOLUME_STEP); break;
            case "ArrowDown": changeVolumeBoost(-VOLUME_STEP); break;
            case "Digit9": resetVolumeBoost(); break;
            case "KeyM": toggleMute(); break;
            default: handled = false;
        }
    } else {
        switch (event.code) {
            case "Period": stepFrame(1); break;
            case "Comma": stepFrame(-1); break;
            default: handled = false;
        }
    }

    if (handled) {
        // Prevent YouTube/etc. from also handling the shortcut.
        event.preventDefault();
        event.stopImmediatePropagation();
    }
}, true);