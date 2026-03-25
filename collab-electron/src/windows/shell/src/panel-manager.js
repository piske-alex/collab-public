/**
 * Generic panel factory for left/right sidebar panels.
 *
 * @param {string} side - Panel identifier ("nav", "terminal")
 * @param {object} config
 * @param {HTMLElement} config.panel - The panel DOM element
 * @param {HTMLElement} config.resizeHandle - The resize drag handle
 * @param {HTMLElement} config.toggle - The toggle button
 * @param {string} config.label - Human-readable label ("Navigator", "Terminals")
 * @param {number} config.defaultWidth - Default panel width in pixels
 * @param {1|-1} config.direction - Resize drag direction: 1=left panel, -1=right panel
 * @param {() => Array} [config.getAllWebviews] - Returns all webviews for pointer-event blocking during resize
 * @param {(visible: boolean) => void} [config.onVisibilityChanged] - Called when visibility changes
 */
function getPanelConstraints(side) {
	const s = getComputedStyle(document.documentElement);
	const min = parseInt(
		s.getPropertyValue(`--panel-${side}-min`).trim(), 10,
	);
	const max = parseInt(
		s.getPropertyValue(`--panel-${side}-max`).trim(), 10,
	);
	return { min, max };
}

export function createPanel(side, config) {
	const {
		panel, resizeHandle, toggle,
		label, defaultWidth, direction,
		getAllWebviews = () => [],
		onVisibilityChanged = () => {},
	} = config;

	let visible = true;
	const prefCache = {};

	function savePref(key, value) {
		prefCache[key] = value;
		window.shellApi.setPref(key, value);
	}

	function loadPref(key) {
		const value = prefCache[key];
		if (value == null) return null;
		return value;
	}

	function updateTogglePosition() {
		const panelsEl = document.getElementById("panels");
		const panelsRect = panelsEl.getBoundingClientRect();
		const centerY = panelsRect.top + panelsRect.height / 2;

		if (direction === 1) {
			// Left panel: toggle sits right of the panel
			if (visible) {
				const rect = panel.getBoundingClientRect();
				toggle.style.left = `${rect.right + 8}px`;
			} else {
				toggle.style.left = `${panelsRect.left + 8}px`;
			}
			toggle.style.right = "";
		} else {
			// Right panel: toggle sits left of the panel
			if (visible) {
				const rect = panel.getBoundingClientRect();
				toggle.style.right =
					`${panelsRect.right - rect.left + 8}px`;
			} else {
				toggle.style.right = `${8}px`;
			}
			toggle.style.left = "";
		}
		toggle.style.top = `${centerY}px`;
		toggle.style.transform = "translateY(-50%)";
	}

	function applyVisibility() {
		if (visible) {
			panel.style.display = "";
			resizeHandle.style.display = "";
			const stored = loadPref(`panel-width-${side}`);
			const px =
				stored != null && stored > 1 ? stored : defaultWidth;
			panel.style.flex = `0 0 ${px}px`;
		} else {
			panel.style.display = "none";
			resizeHandle.style.display = "none";
		}
		toggle.setAttribute("aria-pressed", String(visible));
		toggle.setAttribute(
			"aria-label",
			visible ? `Hide ${label}` : `Show ${label}`,
		);
		toggle.title = visible ? `Hide ${label}` : `Show ${label}`;
		onVisibilityChanged(visible);
		updateTogglePosition();
	}

	function setupResize(onResize = () => {}) {
		const resizeOverlay =
			document.getElementById("resize-overlay");

		resizeHandle.addEventListener("mousedown", (e) => {
			e.preventDefault();
			const startX = e.clientX;
			const startWidth =
				panel.getBoundingClientRect().width;
			let prevClamped = startWidth;

			resizeHandle.classList.add("active");
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
			if (resizeOverlay) {
				resizeOverlay.style.display = "block";
			}

			for (const h of getAllWebviews()) {
				h.webview.style.pointerEvents = "none";
			}

			function onMouseMove(e) {
				const constraints = getPanelConstraints(side);
				const delta = (e.clientX - startX) * direction;
				const unclamped = startWidth + delta;
				const clamped = Math.max(
					constraints.min,
					Math.min(constraints.max, unclamped),
				);
				const counterDelta = prevClamped - clamped;
				prevClamped = clamped;
				panel.style.flex = `0 0 ${clamped}px`;
				onResize(counterDelta);
			}

			function onMouseUp() {
				resizeHandle.classList.remove("active");
				document.removeEventListener(
					"mousemove", onMouseMove,
				);
				document.removeEventListener(
					"mouseup", onMouseUp,
				);
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
				if (resizeOverlay) {
					resizeOverlay.style.display = "";
				}

				for (const h of getAllWebviews()) {
					h.webview.style.pointerEvents = "";
				}

				savePref(
					`panel-width-${side}`,
					panel.getBoundingClientRect().width,
				);
			}

			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
		});
	}

	function initPrefs(prefWidth, prefVisible) {
		if (prefWidth != null) {
			prefCache[`panel-width-${side}`] = prefWidth;
		}
		if (prefVisible != null) {
			prefCache[`panel-visible-${side}`] = prefVisible;
		}
		const storedVisible = prefCache[`panel-visible-${side}`];
		visible = storedVisible == null ? true : !!storedVisible;
	}

	return {
		applyVisibility,
		isVisible() { return visible; },
		toggle() {
			visible = !visible;
			savePref(`panel-visible-${side}`, visible);
			applyVisibility();
		},
		setVisible(v) {
			visible = v;
			savePref(`panel-visible-${side}`, visible);
			applyVisibility();
		},
		updateTogglePosition,
		setupResize,
		savePref,
		loadPref,
		initPrefs,
	};
}
