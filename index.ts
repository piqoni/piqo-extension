/**
 * Piqo Extension
 *
 * Watches directories for file changes. When a file contains one or more
 * @piqo markers, it reads the file, focuses on the @piqo context, and sends
 * it to pi's LLM to generate or modify content. The LLM must remove the
 * human @piqo prompt line/tag as part of its edit, so no /piqo/ closing marker
 * is needed.
 *
 * Usage:
 *   pi -e ./piqo-extension --dir /path/to/dir1,/path/to/dir2
 *
 * In headless (print) mode:
 *   pi -e ./piqo-extension --dir /path/to/dir1 -p "Start piqo watcher"
 *
 * Marker format:
 *   @piqo <instruction here>
 *   ... LLM replaces the prompt with generated content and removes @piqo ...
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Track which files are currently being processed to avoid duplicate agent runs
interface PiqoMarker {
	filePath: string;
	lineNumber: number;
	instruction: string;
	lineText: string;
}

const PIQO_PROMPT_SENTINEL = "[piqo-request]";
const TEXT_FILE_EXTENSIONS = new Set([
	".txt", ".md", ".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".rs",
	".go", ".java", ".c", ".cpp", ".h", ".hpp", ".css", ".html", ".xml",
	".json", ".yaml", ".yml", ".toml", ".sh", ".bash", ".zsh", ".fish",
	".sql", ".r", ".swift", ".kt", ".scala", ".lua", ".vim", ".el",
	".clj", ".hs", ".ml", ".ex", ".exs", ".erl", ".dart", ".cs",
	".php", ".pl", ".pm", ".svelte", ".vue", ".astro", ".mdx", ".markdown"
]);

function isTextFile(filePath: string): boolean {
	return TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function getMessageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part?.type === "text" && typeof part.text === "string") return part.text;
			return "";
		})
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	// Register the --dir flag
	pi.registerFlag("dir", {
		description: "Comma-separated directories to watch for @piqo markers",
		type: "string",
		default: "",
	});

	const processing = new Set<string>(); // file paths currently being processed
	const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>(); // per-file debounce
	const watchers: fs.FSWatcher[] = [];

	// Isolate Piqo LLM calls from prior chat/session history.
	// We keep messages from the current Piqo request onward so tool-call loops
	// still work, but older user/assistant turns cannot affect the request.
	pi.on("context", async (event) => {
		let piqoStartIdx = -1;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "user" && getMessageText(message).includes(PIQO_PROMPT_SENTINEL)) {
				piqoStartIdx = i;
				break;
			}
		}

		if (piqoStartIdx === -1) return;
		return { messages: event.messages.slice(piqoStartIdx) };
	});

   /**
	 * Strip inline code spans (backtick-delimited) from a line.
	 * Handles single and double backtick delimiters.
	 */
	function stripInlineCode(line: string): string {
		// Remove `` ... `` first (double-backtick spans), then ` ... `
		return line.replace(/``[^`]*``/g, "").replace(/`[^`]*`/g, "");
	}

	/**
	 * Scan a file for @piqo markers. Markers are considered pending until the
	 * agent removes the human prompt line/tag from the file.
	 *
	 * Skips:
	 *  - Lines inside fenced code blocks (``` ... ```)
	 *  - Indented code lines (4+ spaces or leading tab)
	 *  - @piqo inside inline code spans (`@piqo ...`)
	 */
	function findMarkers(filePath: string): PiqoMarker[] {
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			return [];
		}

		const lines = content.split("\n");
		const markers: PiqoMarker[] = [];
		let inCodeFence = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Toggle fenced code block state (``` or ~~~)
			if (/^\s*(```|~~~)/.test(line)) {
				inCodeFence = !inCodeFence;
				continue;
			}

			// Skip lines inside code fences
			if (inCodeFence) continue;

			// Skip indented code blocks (4+ spaces or leading tab)
			if (/^(\t| {4})/.test(line)) continue;

			// Strip inline code spans before matching @piqo
			const stripped = stripInlineCode(line);
			const piqoMatch = stripped.match(/@piqo\b(.*)/);
			if (!piqoMatch) continue;

			markers.push({
				filePath,
				lineNumber: i + 1,
				instruction: piqoMatch[1].trim(),
				lineText: line,
			});
		}

		return markers;
	}

	/**
	 * Build context around a @piqo marker for the LLM.
	 * Includes surrounding lines for context.
	 */
	function buildContext(filePath: string, marker: PiqoMarker): string {
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			return "";
		}

		const lines = content.split("\n");
		const markerLineIdx = marker.lineNumber - 1;

		// Get surrounding context (up to 30 lines before and 10 after)
		const contextBefore = Math.max(0, markerLineIdx - 30);
		const contextAfter = Math.min(lines.length, markerLineIdx + 11);
		const surroundingLines = lines.slice(contextBefore, contextAfter);

		const relativePath = filePath;
		const ext = path.extname(filePath).slice(1) || "txt";

		return [
			`File: ${relativePath}`,
			`Marker at line ${marker.lineNumber}`,
			`Instruction: ${marker.instruction || "(no specific instruction — infer from context)"}`,
			"",
			`\`\`\`${ext}`,
			...surroundingLines.map(
				(line, idx) =>
					`${contextBefore + idx + 1 === marker.lineNumber ? ">>> " : "    "}${line}`
			),
			"```",
		].join("\n");
	}

	/**
	 * Process all @piqo markers in a file in one agent run. This avoids line
	 * shifting and concurrent edit conflicts when a file has multiple markers.
	 */
	function processFileMarkers(filePath: string, markers: PiqoMarker[]): void {
		if (processing.has(filePath)) return;
		processing.add(filePath);

		const contexts = markers.map((marker) => buildContext(filePath, marker)).filter(Boolean);
		if (contexts.length === 0) {
			processing.delete(filePath);
			return;
		}

		const markerList = markers
			.map(
				(marker, idx) =>
					`${idx + 1}. Line ${marker.lineNumber}: ${marker.lineText.trim()}\n   Instruction: ${marker.instruction || "(no specific instruction — infer from context)"}`
			)
			.join("\n");

		const prompt = [
   `${PIQO_PROMPT_SENTINEL} A file has one or more @piqo markers requesting AI assistance. Read the
 file, understand each marker, and fulfill every request in one edit.`,
			"",
			"MARKERS TO PROCESS:",
			markerList,
			"",
			"CONTEXT:",
			contexts.join("\n\n---\n\n"),
			"",
			"INSTRUCTIONS:",
			`1. Read the file "${filePath}" to get the full current content.`,
			"2. For every @piqo marker listed above, generate or modify content as requested by the human prompt after @piqo.",
			"3. CRITICAL: Always remove the human prompt from the file. If @piqo is on its own line or in a comment line, remove that whole prompt line and replace it with the generated content if appropriate.",
			"4. CRITICAL The final file must contain no @piqo tags for the prompts you processed.",
			"5. Keep unrelated content intact and preserve the file's style/formatting.",
			"",
			"Example transformation:",
			"  Before:",
			"    @piqo add a hello world function",
			"  After:",
			"    function helloWorld() {",
			'      console.log("Hello, World!");',
			"    }",
		].join("\n");

		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}

	/**
	 * Handle a file change event: debounce, scan for markers, process.
	 */
	function onFileChange(filePath: string): void {
		// Debounce per file: wait 500ms after last change before processing
		const existing = debounceTimers.get(filePath);
		if (existing) clearTimeout(existing);

		debounceTimers.set(
			filePath,
			setTimeout(() => {
				debounceTimers.delete(filePath);

				const markers = findMarkers(filePath);
				if (markers.length > 0) {
					processFileMarkers(filePath, markers);
				}
			}, 500)
		);
	}

	/**
	 * Recursively watch a directory using fs.watch with recursive option.
	 */
	function watchDirectory(dirPath: string): void {
		const resolvedDir = path.resolve(dirPath);

		if (!fs.existsSync(resolvedDir)) {
			console.error(`[piqo] Directory does not exist: ${resolvedDir}`);
			return;
		}

		try {
			const watcher = fs.watch(resolvedDir, { recursive: true }, (eventType, filename) => {
				if (!filename) return;

				const fullPath = path.join(resolvedDir, filename);

				// Skip hidden files/dirs, node_modules, .git, etc.
				if (
					filename.startsWith(".") ||
					filename.includes("node_modules") ||
					filename.includes(".git") ||
					filename.includes("/.")
				) {
					return;
				}

				if (!isTextFile(filename)) return;

				// Check file exists and is a regular file
				try {
					const stat = fs.statSync(fullPath);
					if (!stat.isFile()) return;
				} catch {
					return; // File may have been deleted
				}

				onFileChange(fullPath);
			});

			watchers.push(watcher);
			console.log(`[piqo] Watching directory: ${resolvedDir}`);
		} catch (err) {
			console.error(`[piqo] Failed to watch ${resolvedDir}:`, err);
		}
	}

	// Clean up on agent_end — remove processing keys for completed markers
	pi.on("agent_end", async (_event, _ctx) => {
		// After the agent finishes a turn, clear the processing set
		// so markers that failed can be retried on next file change
		processing.clear();
	});

	// Start watching on session_start
	pi.on("session_start", async (_event, ctx) => {
		const dirFlag = pi.getFlag("dir") as string;
		if (!dirFlag) {
			if (ctx.hasUI) {
				ctx.ui.notify("[piqo] No --dir specified. Use --dir=path1,path2 to watch directories.", "warning");
			}
			console.log("[piqo] No --dir specified. Piqo is idle.");
			return;
		}

		const dirs = dirFlag
			.split(",")
			.map((d) => d.trim())
			.filter(Boolean);

		if (dirs.length === 0) {
			console.log("[piqo] No valid directories specified.");
			return;
		}

		for (const dir of dirs) {
			watchDirectory(dir);
		}

		if (ctx.hasUI) {
			ctx.ui.notify(`[piqo] Watching ${dirs.length} director${dirs.length === 1 ? "y" : "ies"} for @piqo markers`, "info");
			ctx.ui.setStatus("piqo", `👁 Watching ${dirs.length} dir${dirs.length === 1 ? "" : "s"}`);
		}

		// Do an initial scan of all watched directories
		for (const dir of dirs) {
			const resolvedDir = path.resolve(dir);
			try {
				scanDirectoryRecursive(resolvedDir);
			} catch (err) {
				console.error(`[piqo] Initial scan failed for ${resolvedDir}:`, err);
			}
		}
	});

	/**
	 * Recursively scan a directory for files with @piqo markers.
	 */
	function scanDirectoryRecursive(dirPath: string): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dirPath, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

			const fullPath = path.join(dirPath, entry.name);
			if (entry.isDirectory()) {
				scanDirectoryRecursive(fullPath);
			} else if (entry.isFile()) {
				if (!isTextFile(entry.name)) continue;

				// Quick check if file contains @piqo
				try {
					const content = fs.readFileSync(fullPath, "utf-8");
					if (content.includes("@piqo")) {
						onFileChange(fullPath);
					}
				} catch {
					// skip unreadable files
				}
			}
		}
	}

	// Cleanup watchers on shutdown
	pi.on("session_shutdown", async () => {
		for (const watcher of watchers) {
			try {
				watcher.close();
			} catch {
				// ignore
			}
		}
		watchers.length = 0;

		for (const timer of debounceTimers.values()) {
			clearTimeout(timer);
		}
		debounceTimers.clear();
		processing.clear();

		console.log("[piqo] Watchers closed.");
	});
}
