import {
	tiles, addTile, removeTile, getTile, bringToFront,
	generateId, defaultSize, inferTileType, snapToGrid,
	selectTile, deselectTile, toggleTileSelection,
	clearSelection, isSelected, getSelectedTiles,
} from "./canvas-state.js";
import {
	createTileDOM, positionTile, updateTileTitle, getTileLabel,
} from "./tile-renderer.js";
import { attachDrag, attachResize } from "./tile-interactions.js";

/**
 * Tile lifecycle manager: creation, deletion, persistence, webview
 * spawning, focus, selection visuals, and canvas save/restore.
 */
export function createTileManager({
	tileLayer, viewportState, configs,
	getAllWebviews, isSpaceHeld,
	onSaveDebounced, onSaveImmediate,
	onNoteSurfaceFocus, onFocusSurface,
	onTerminalSessionCreated,
	onTerminalTileClosed,
	onTileFocused,
	onTileDblClick,
}) {
	/** @type {Map<string, {container: HTMLElement, contentArea: HTMLElement, titleText: HTMLElement, webview?: HTMLElement}>} */
	const tileDOMs = new Map();
	let saveTimer = null;
	let focusedTileId = null;

	// Viewport read-only accessor for tile-interactions
	const viewport = {
		get panX() { return viewportState.panX; },
		get panY() { return viewportState.panY; },
		get zoom() { return viewportState.zoom; },
	};

	// -- Canvas persistence --

	function getCanvasStateForSave() {
		return {
			version: 1,
			tiles: tiles.map((t) => ({
				id: t.id,
				type: t.type,
				x: t.x,
				y: t.y,
				width: t.width,
				height: t.height,
				filePath: t.filePath,
				folderPath: t.folderPath,
				workspacePath: t.workspacePath,
				ptySessionId: t.ptySessionId,
				shell: t.shell,
				label: t.label,
				url: t.url,
				zIndex: t.zIndex,
			})),
			viewport: {
				panX: viewportState.panX,
				panY: viewportState.panY,
				zoom: viewportState.zoom,
			},
		};
	}

	function saveCanvasDebounced() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			onSaveDebounced(getCanvasStateForSave());
		}, 500);
	}

	function saveCanvasImmediate() {
		clearTimeout(saveTimer);
		onSaveImmediate(getCanvasStateForSave());
	}

	// -- Tile positioning --

	function repositionAllTiles() {
		for (const tile of tiles) {
			const dom = tileDOMs.get(tile.id);
			if (!dom) continue;
			positionTile(
				dom.container, tile,
				viewportState.panX, viewportState.panY,
				viewportState.zoom,
			);
		}
	}

	// -- Selection visuals --

	function syncSelectionVisuals() {
		for (const [id, dom] of tileDOMs) {
			dom.container.classList.toggle(
				"tile-selected", isSelected(id),
			);
		}
	}

	// -- Focus management --

	function clearTileFocusRing() {
		for (const [, d] of tileDOMs) {
			d.container.classList.remove("tile-focused");
		}
	}

	function blurCanvasTileGuest(id = focusedTileId) {
		if (!id) return;
		const dom = tileDOMs.get(id);
		if (!dom?.webview) return;
		try { dom.webview.send("shell-blur"); } catch { /* noop */ }
		try { dom.webview.blur(); } catch { /* noop */ }
	}

	function forwardClickToWebview(webview, mouseEvent) {
		const rect = webview.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		const x = Math.round(
			(mouseEvent.clientX - rect.left)
			* (webview.offsetWidth / rect.width),
		);
		const y = Math.round(
			(mouseEvent.clientY - rect.top)
			* (webview.offsetHeight / rect.height),
		);
		if (x < 0 || y < 0) return;
		if (x > webview.offsetWidth || y > webview.offsetHeight) return;
		webview.sendInputEvent({
			type: "mouseDown", x, y, button: "left", clickCount: 1,
		});
		webview.sendInputEvent({
			type: "mouseUp", x, y, button: "left", clickCount: 1,
		});
	}

	function focusCanvasTile(id, mouseEvent) {
		const tile = getTile(id);
		if (tile) {
			bringToFront(tile);
			repositionAllTiles();
		}
		const dom = tileDOMs.get(id);
		if (dom && dom.webview) {
			if (focusedTileId && focusedTileId !== id) {
				blurCanvasTileGuest(focusedTileId);
			}
			focusedTileId = id;
			if (onTileFocused) {
				onTileFocused(tile);
			}
			clearTileFocusRing();
			dom.container.classList.add("tile-focused");
			dom.webview.focus();
			onNoteSurfaceFocus("canvas-tile");

			if (
				mouseEvent && mouseEvent.button === 0 &&
				tile.type !== "browser"
			) {
				forwardClickToWebview(dom.webview, mouseEvent);
			} else if (!mouseEvent && tile.type === "term") {
				// Programmatic focus (e.g. from terminal list) —
				// simulate a click in the center so xterm grabs focus
				setTimeout(() => {
					try {
						const x = Math.round(dom.webview.offsetWidth / 2);
						const y = Math.round(dom.webview.offsetHeight / 2);
						dom.webview.sendInputEvent({
							type: "mouseDown", x, y, button: "left", clickCount: 1,
						});
						dom.webview.sendInputEvent({
							type: "mouseUp", x, y, button: "left", clickCount: 1,
						});
					} catch { /* noop */ }
				}, 100);
			}
		}
	}

	// -- Webview spawning --

	function spawnTerminalWebview(tile, autoFocus = false) {
		const dom = tileDOMs.get(tile.id);
		if (!dom) return;

		const wv = document.createElement("webview");
		const termConfig = configs.terminalTile;
		const params = new URLSearchParams();
		if (tile.ptySessionId) {
			params.set("sessionId", tile.ptySessionId);
			params.set("restored", "1");
		} else if (tile.cwd) {
			params.set("cwd", tile.cwd);
		}
		// Pass saved shell so restored terminals use the right shell (e.g. wsl vs powershell)
		if (tile.shell) {
			params.set("shell", tile.shell);
		}
		const qs = params.toString();
		wv.setAttribute(
			"src",
			qs ? `${termConfig.src}?${qs}` : termConfig.src,
		);
		wv.setAttribute("preload", termConfig.preload);
		wv.setAttribute(
			"webpreferences", "contextIsolation=yes, sandbox=yes",
		);
		wv.style.width = "100%";
		wv.style.height = "100%";
		wv.style.border = "none";

		dom.contentArea.appendChild(wv);
		dom.webview = wv;

		wv.addEventListener("dom-ready", () => {
			if (autoFocus) focusCanvasTile(tile.id);
			wv.addEventListener("before-input-event", () => {});
		});

		wv.addEventListener("ipc-message", (event) => {
			if (event.channel === "pty-session-id") {
				tile.ptySessionId = event.args[0];
				tile.shell = event.args[1] || undefined;
				saveCanvasDebounced();
				if (onTerminalSessionCreated) {
					onTerminalSessionCreated(tile);
				}
			}
		});
	}

	function spawnGraphWebview(tile) {
		const dom = tileDOMs.get(tile.id);
		if (!dom) return;

		const wv = document.createElement("webview");
		const graphConfig = configs.graphTile;
		const params = new URLSearchParams();
		params.set("folder", tile.folderPath);
		params.set("workspace", tile.workspacePath ?? "");
		const qs = params.toString();
		wv.setAttribute("src", `${graphConfig.src}?${qs}`);
		wv.setAttribute("preload", graphConfig.preload);
		wv.setAttribute(
			"webpreferences", "contextIsolation=yes, sandbox=yes",
		);
		wv.style.width = "100%";
		wv.style.height = "100%";
		wv.style.border = "none";

		dom.contentArea.appendChild(wv);
		dom.webview = wv;
	}

	function spawnBrowserWebview(tile, autoFocus = false) {
		const dom = tileDOMs.get(tile.id);
		if (!dom) return;

		if (!tile.url) {
			if (autoFocus && dom.urlInput) {
				dom.urlInput.focus();
			}
			return;
		}

		let url = tile.url;
		if (!/^https?:\/\//i.test(url)) {
			const isLocal = /^localhost(:|$)/i.test(url) ||
				/^127\.0\.0\.1(:|$)/.test(url);
			url = (isLocal ? "http://" : "https://") + url;
			tile.url = url;
		}
		const blocked = /^(javascript|file|data):/i;
		if (blocked.test(url)) return;

		const wv = document.createElement("webview");
		wv.setAttribute("src", url);
		wv.setAttribute("allowpopups", "");
		wv.setAttribute("partition", "persist:browser");
		wv.setAttribute(
			"webpreferences", "contextIsolation=yes, sandbox=yes",
		);
		wv.style.width = "100%";
		wv.style.height = "100%";
		wv.style.border = "none";

		dom.contentArea.appendChild(wv);
		dom.webview = wv;

		const stopSvg = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
		const reloadSvg = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3v4h-4"/><path d="M12.36 10a5 5 0 1 1-.96-5.36L13 7"/></svg>`;

		function updateNavState() {
			if (dom.navBack) {
				dom.navBack.disabled = !wv.canGoBack();
			}
			if (dom.navForward) {
				dom.navForward.disabled = !wv.canGoForward();
			}
		}

		// Replace buttons with clones to strip stale listeners
		for (const key of ["navBack", "navForward", "navReload"]) {
			if (dom[key]) {
				const fresh = dom[key].cloneNode(true);
				dom[key].replaceWith(fresh);
				dom[key] = fresh;
			}
		}

		if (dom.navBack) {
			dom.navBack.addEventListener("click", (e) => {
				e.stopPropagation();
				if (wv.canGoBack()) wv.goBack();
			});
		}
		if (dom.navForward) {
			dom.navForward.addEventListener("click", (e) => {
				e.stopPropagation();
				if (wv.canGoForward()) wv.goForward();
			});
		}
		if (dom.navReload) {
			dom.navReload.addEventListener("click", (e) => {
				e.stopPropagation();
				if (wv.isLoading()) {
					wv.stop();
				} else {
					wv.reload();
				}
			});
		}

		wv.addEventListener("dom-ready", () => {
			wv.setZoomFactor(0.85);
		});

		function clearErrors() {
			for (const el of [
				...dom.contentArea.querySelectorAll(".tile-load-error"),
			]) {
				el.remove();
			}
		}

		wv.addEventListener("did-start-loading", () => {
			clearErrors();
			wv.style.display = "";
			if (dom.navReload) {
				dom.navReload.innerHTML = stopSvg;
				dom.navReload.title = "Stop";
			}
		});

		wv.addEventListener("did-stop-loading", () => {
			if (dom.navReload) {
				dom.navReload.innerHTML = reloadSvg;
				dom.navReload.title = "Reload";
			}
			updateNavState();
		});

		wv.addEventListener("did-navigate", (e) => {
			tile.url = e.url;
			if (dom.urlInput) dom.urlInput.value = e.url;
			updateTileTitle(dom, tile);
			updateNavState();
			saveCanvasDebounced();
		});

		wv.addEventListener("did-navigate-in-page", (e) => {
			if (e.isMainFrame) {
				tile.url = e.url;
				if (dom.urlInput) dom.urlInput.value = e.url;
				updateTileTitle(dom, tile);
				updateNavState();
				saveCanvasDebounced();
			}
		});

		wv.addEventListener("did-fail-load", (e) => {
			if (e.errorCode === -3) return;
			if (!e.isMainFrame) return;
			clearErrors();
			wv.style.display = "none";
			const errDiv = document.createElement("div");
			errDiv.className = "tile-load-error";
			errDiv.style.cssText =
				"padding:20px;color:#888;font-size:13px;";
			errDiv.textContent =
				`Failed to load: ${e.validatedURL || tile.url}`;
			dom.contentArea.appendChild(errDiv);
		});

		wv.addEventListener("render-process-gone", () => {
			const crashDiv = document.createElement("div");
			crashDiv.style.cssText =
				"padding:20px;color:#888;font-size:13px;";
			crashDiv.textContent =
				"Page crashed. Edit the URL and press Enter to reload.";
			if (dom.webview) {
				dom.contentArea.removeChild(dom.webview);
				dom.webview = null;
			}
			dom.contentArea.appendChild(crashDiv);
		});

		if (autoFocus) {
			wv.addEventListener(
				"dom-ready", () => focusCanvasTile(tile.id),
			);
		}
	}

	// -- Tile CRUD --

	function createCanvasTile(type, cx, cy, extra = {}) {
		const size = defaultSize(type);
		const tile = addTile({
			id: extra.id || generateId(),
			type,
			x: cx,
			y: cy,
			width: extra.width || size.width,
			height: extra.height || size.height,
			...extra,
		});
		snapToGrid(tile);
		window.shellApi.trackEvent("tile_created", { type });

		const dom = createTileDOM(tile, {
			onClose: (id) => closeCanvasTile(id),
			onFocus: (id, e) => {
				if (e && e.shiftKey) {
					toggleTileSelection(id);
					syncSelectionVisuals();
					return;
				}
				clearSelection();
				syncSelectionVisuals();
				focusCanvasTile(id, e);
			},
			onOpenInViewer: (id) => {
				const t = getTile(id);
				if (t?.filePath) {
					window.shellApi.trackEvent(
						"tile_opened_in_viewer", { type: t.type },
					);
					window.shellApi.selectFile(t.filePath);
				}
			},
			onNavigate: (id, url) => {
				const t = getTile(id);
				if (!t || t.type !== "browser") return;
				t.url = url;
				const d = tileDOMs.get(id);
				if (d?.webview) {
					d.contentArea.removeChild(d.webview);
					d.webview = null;
				}
				spawnBrowserWebview(t);
				saveCanvasImmediate();
			},
		});

		// Double-click title bar → center tile in viewport
		dom.titleBar.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			if (onTileDblClick) onTileDblClick(tile);
		});

		attachDrag(dom.titleBar, tile, {
			viewport,
			onUpdate: repositionAllTiles,
			disablePointerEvents: (wvs) => {
				for (const w of wvs) {
					w.webview.style.pointerEvents = "none";
				}
			},
			enablePointerEvents: (wvs) => {
				for (const w of wvs) {
					w.webview.style.pointerEvents = "";
				}
			},
			getAllWebviews,
			getGroupDragContext: () => {
				if (
					!isSelected(tile.id) ||
					getSelectedTiles().length <= 1
				) {
					return null;
				}
				return getSelectedTiles().map((t) => ({
					tile: t,
					container: tileDOMs.get(t.id)?.container,
					startX: t.x,
					startY: t.y,
				}));
			},
			onShiftClick: (id) => {
				toggleTileSelection(id);
				syncSelectionVisuals();
			},
			onFocus: (id, e) => focusCanvasTile(id, e),
			isSpaceHeld,
			contentOverlay: dom.contentOverlay,
		});
		attachResize(
			dom.container, tile, viewport,
			repositionAllTiles,
			getAllWebviews,
		);

		tileLayer.appendChild(dom.container);
		tileDOMs.set(tile.id, dom);
		positionTile(
			dom.container, tile,
			viewportState.panX, viewportState.panY,
			viewportState.zoom,
		);

		return tile;
	}

	function closeCanvasTile(id) {
		const dom = tileDOMs.get(id);
		if (dom) {
			dom.container.remove();
			tileDOMs.delete(id);
		}
		deselectTile(id);
		const tile = getTile(id);
		if (tile) {
			window.shellApi.trackEvent(
				"tile_closed", { type: tile.type },
			);
			if (tile.type === "term" && tile.ptySessionId) {
				window.shellApi.ptyKillSession(tile.ptySessionId);
				if (onTerminalTileClosed) {
					onTerminalTileClosed(tile.ptySessionId);
				}
			}
		}
		removeTile(id);
		saveCanvasImmediate();
	}

	function createFileTile(type, cx, cy, filePath, extra = {}) {
		const tile = createCanvasTile(type, cx, cy, { filePath, ...extra });
		const dom = tileDOMs.get(tile.id);
		if (!dom) return tile;

		if (type === "image") {
			const img = document.createElement("img");
			img.src = `collab-file://${filePath}`;
			img.style.width = "100%";
			img.style.height = "100%";
			img.style.objectFit = "contain";
			img.draggable = false;
			dom.contentArea.appendChild(img);
		} else {
			const wv = document.createElement("webview");
			const viewerConfig = configs.viewer;
			const mode = type === "note" ? "note" : "code";
			wv.setAttribute(
				"src",
				`${viewerConfig.src}?tilePath=${encodeURIComponent(filePath)}&tileMode=${mode}`,
			);
			wv.setAttribute("preload", viewerConfig.preload);
			wv.setAttribute(
				"webpreferences",
				"contextIsolation=yes, sandbox=yes",
			);
			wv.style.width = "100%";
			wv.style.height = "100%";
			wv.style.border = "none";

			dom.contentArea.appendChild(wv);
			dom.webview = wv;

			wv.addEventListener("dom-ready", () => {});
		}

		saveCanvasImmediate();
		return tile;
	}

	function createGraphTile(cx, cy, folderPath, workspacePath) {
		const tile = createCanvasTile("graph", cx, cy, {
			folderPath, workspacePath,
		});
		spawnGraphWebview(tile);
		saveCanvasImmediate();
		return tile;
	}

	function clearCanvas(viewportObj) {
		const tileIds = tiles.map((t) => t.id);
		for (const id of tileIds) {
			closeCanvasTile(id);
		}
		viewportState.panX = 0;
		viewportState.panY = 0;
		viewportState.zoom = 1;
		viewportObj.updateCanvas();
		saveCanvasImmediate();
	}

	// -- Canvas state restore --

	function restoreCanvasState(savedTiles) {
		// On non-tmux platforms (Windows/Linux), PTY sessions don't survive
		// restarts. Clear stale ptySessionIds so fresh terminals are spawned
		// instead of ghost reconnection attempts.
		const canReconnect = window.shellApi.getPlatform?.() === "darwin";

		for (const saved of savedTiles) {
			if (saved.type === "term") {
				const tile = createCanvasTile(
					"term", saved.x, saved.y, {
						id: saved.id,
						width: saved.width,
						height: saved.height,
						zIndex: saved.zIndex,
						ptySessionId: canReconnect ? saved.ptySessionId : undefined,
						cwd: saved.workspacePath || saved.cwd,
						shell: saved.shell,
						label: saved.label,
						workspacePath: saved.workspacePath,
					},
				);
				spawnTerminalWebview(tile);
			} else if (saved.type === "graph" && saved.folderPath) {
				const tile = createCanvasTile(
					"graph", saved.x, saved.y, {
						id: saved.id,
						width: saved.width,
						height: saved.height,
						zIndex: saved.zIndex,
						folderPath: saved.folderPath,
						workspacePath: saved.workspacePath,
					},
				);
				spawnGraphWebview(tile);
			} else if (saved.type === "browser") {
				const tile = createCanvasTile(
					"browser", saved.x, saved.y, {
						id: saved.id,
						width: saved.width,
						height: saved.height,
						zIndex: saved.zIndex,
						url: saved.url,
						workspacePath: saved.workspacePath,
					},
				);
				spawnBrowserWebview(tile);
			} else if (saved.filePath) {
				createFileTile(
					saved.type, saved.x, saved.y, saved.filePath,
					{ workspacePath: saved.workspacePath },
				);
			}
		}
	}

	function updateTerminalLabel(sessionId, label) {
		for (const t of tiles) {
			if (t.type === "term" && t.ptySessionId === sessionId) {
				t.label = label || undefined;
				const dom = tileDOMs.get(t.id);
				if (dom) updateTileTitle(dom, t);
				saveCanvasDebounced();
				return;
			}
		}
	}

	// -- Tile updates for external events --

	function updateTileForRename(oldPath, newPath) {
		let anyUpdated = false;
		for (const t of tiles) {
			if (t.filePath === oldPath) {
				t.filePath = newPath;
				t.type = inferTileType(newPath);
				const dom = tileDOMs.get(t.id);
				if (dom) updateTileTitle(dom, t);
				anyUpdated = true;
			}
			if (
				t.type === "graph" && t.folderPath &&
				(t.folderPath === oldPath ||
					t.folderPath.startsWith(oldPath + "/"))
			) {
				t.folderPath =
					newPath + t.folderPath.slice(oldPath.length);
				const dom = tileDOMs.get(t.id);
				if (dom) {
					updateTileTitle(dom, t);
					if (dom.webview) {
						dom.webview.send(
							"scope-changed", t.folderPath,
						);
					}
				}
				anyUpdated = true;
			}
		}
		if (anyUpdated) saveCanvasDebounced();
	}

	function closeTilesForDeletedPaths(deletedPaths) {
		const deleted = new Set(deletedPaths);
		for (const t of [...tiles]) {
			if (t.filePath && deleted.has(t.filePath)) {
				closeCanvasTile(t.id);
			}
			if (
				t.type === "graph" && t.folderPath &&
				deleted.has(t.folderPath)
			) {
				closeCanvasTile(t.id);
			}
		}
	}

	function broadcastToTileWebviews(channel, ...args) {
		for (const [, dom] of tileDOMs) {
			if (dom.webview) dom.webview.send(channel, ...args);
		}
	}

	function filterTilesByWorkspace(workspacePath) {
		for (const tile of tiles) {
			const dom = tileDOMs.get(tile.id);
			if (!dom) continue;
			// Tiles without a workspacePath are always visible
			if (!tile.workspacePath) {
				dom.container.style.display = "";
				continue;
			}
			const match = tile.workspacePath === workspacePath;
			dom.container.style.display = match ? "" : "none";
		}
	}

	return {
		createCanvasTile,
		closeCanvasTile,
		focusCanvasTile,
		blurCanvasTileGuest,
		clearTileFocusRing,
		repositionAllTiles,
		syncSelectionVisuals,
		spawnTerminalWebview,
		spawnGraphWebview,
		spawnBrowserWebview,
		createFileTile,
		createGraphTile,
		clearCanvas,
		getCanvasStateForSave,
		restoreCanvasState,
		getTileDOMs: () => tileDOMs,
		getFocusedTileId: () => focusedTileId,
		setFocusedTileId: (id) => { focusedTileId = id; },
		updateTileForRename,
		updateTerminalLabel,
		closeTilesForDeletedPaths,
		broadcastToTileWebviews,
		filterTilesByWorkspace,
		saveCanvasDebounced,
		saveCanvasImmediate,
	};
}
