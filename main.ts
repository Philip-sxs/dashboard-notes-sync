import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
	requestUrl,
} from "obsidian";

interface DashboardSyncSettings {
	baseUrl: string;
	syncFolder: string;
	syncOnStartup: boolean;
	lastSyncedAt: string | null;
}

const DEFAULT_SETTINGS: DashboardSyncSettings = {
	baseUrl: "http://pie:3000",
	syncFolder: "Dashboard-Ideen",
	syncOnStartup: false,
	lastSyncedAt: null,
};

interface RemoteNote {
	id: string;
	text: string;
	createdAt: string;
	updatedAt?: string;
}

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;

function stripFrontmatter(content: string): string {
	return content.replace(FRONTMATTER_RE, "");
}

// Non-cryptographic — only used to detect whether text changed since the last sync.
function hashText(text: string): string {
	let hash = 0;
	for (let i = 0; i < text.length; i++) {
		hash = (hash * 31 + text.charCodeAt(i)) | 0;
	}
	return hash.toString(36);
}

function sanitizeFilename(text: string): string {
	const firstLine = text.split("\n")[0].trim();
	const truncated = (firstLine || "Notiz").slice(0, 60);
	const cleaned = truncated.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
	return cleaned || "Notiz";
}

export default class DashboardNotesSyncPlugin extends Plugin {
	settings!: DashboardSyncSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new DashboardSyncSettingTab(this.app, this));

		this.addRibbonIcon("refresh-cw", "Dashboard-Notizen synchronisieren", () => this.syncNow());

		this.addCommand({
			id: "sync-dashboard-notes",
			name: "Dashboard-Notizen synchronisieren",
			callback: () => this.syncNow(),
		});

		if (this.settings.syncOnStartup) {
			// Fire-and-forget: the dashboard is only reachable on the LAN, so this
			// should never block startup if the device is currently off-network.
			this.app.workspace.onLayoutReady(() => {
				this.syncNow(true).catch((e) => console.error("Dashboard Notes Sync: Start-Sync fehlgeschlagen", e));
			});
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private apiUrl(path: string): string {
		return `${this.settings.baseUrl.replace(/\/$/, "")}${path}`;
	}

	private async fetchRemoteNotes(): Promise<RemoteNote[]> {
		const res = await requestUrl({ url: this.apiUrl("/api/notes"), method: "GET" });
		return res.json;
	}

	private async pushNew(text: string): Promise<RemoteNote> {
		const res = await requestUrl({
			url: this.apiUrl("/api/notes"),
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ text }),
		});
		return res.json;
	}

	private async pushUpdate(id: string, text: string): Promise<RemoteNote> {
		const res = await requestUrl({
			url: this.apiUrl(`/api/notes/${id}`),
			method: "PATCH",
			contentType: "application/json",
			body: JSON.stringify({ text }),
		});
		return res.json;
	}

	private async ensureFolderRecursive(folderPath: string) {
		const adapter = this.app.vault.adapter;
		const parts = folderPath.split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await adapter.exists(current))) {
				await adapter.mkdir(current);
			}
		}
	}

	private async getUniqueFilePath(folder: string, baseName: string): Promise<string> {
		let candidate = normalizePath(`${folder}/${baseName}.md`);
		let i = 2;
		while (await this.app.vault.adapter.exists(candidate)) {
			candidate = normalizePath(`${folder}/${baseName} ${i}.md`);
			i++;
		}
		return candidate;
	}

	private async replaceBody(file: TFile, newBody: string) {
		const current = await this.app.vault.read(file);
		const match = current.match(FRONTMATTER_RE);
		const prefix = match ? match[0] : "";
		await this.app.vault.modify(file, prefix + newBody);
	}

	async syncNow(silent = false) {
		let notes: RemoteNote[];
		try {
			notes = await this.fetchRemoteNotes();
		} catch (e) {
			if (!silent) {
				new Notice(`Dashboard nicht erreichbar (${this.settings.baseUrl}). Bist du im LAN?`);
			}
			console.error("Dashboard Notes Sync: fetch fehlgeschlagen", e);
			return;
		}

		const folder = normalizePath(this.settings.syncFolder);
		await this.ensureFolderRecursive(folder);

		const localFiles = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(folder + "/"));
		const localByRemoteId = new Map<string, TFile>();
		for (const f of localFiles) {
			const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.["dashboard-note-id"];
			if (id) localByRemoteId.set(id, f);
		}

		let created = 0;
		let pulledUpdates = 0;
		let pushedNew = 0;
		let pushedUpdates = 0;
		let conflicts = 0;

		for (const note of notes) {
			const existing = localByRemoteId.get(note.id);

			if (!existing) {
				const path = await this.getUniqueFilePath(folder, sanitizeFilename(note.text));
				const file = await this.app.vault.create(path, note.text);
				await this.app.fileManager.processFrontMatter(file, (fm) => {
					fm["dashboard-note-id"] = note.id;
					fm["dashboard-sync-hash"] = hashText(note.text);
					fm["dashboard-updated-at"] = note.updatedAt ?? note.createdAt;
				});
				created++;
				continue;
			}

			const fm = this.app.metadataCache.getFileCache(existing)?.frontmatter ?? {};
			const storedHash = fm["dashboard-sync-hash"];
			const localBody = stripFrontmatter(await this.app.vault.read(existing));
			const localChanged = hashText(localBody) !== storedHash;
			const remoteChanged = hashText(note.text) !== storedHash;

			if (localChanged && remoteChanged) {
				conflicts++;
				if (localBody.trim()) {
					const updated = await this.pushUpdate(note.id, localBody);
					await this.app.fileManager.processFrontMatter(existing, (fm) => {
						fm["dashboard-sync-hash"] = hashText(localBody);
						fm["dashboard-updated-at"] = updated.updatedAt ?? updated.createdAt;
					});
					pushedUpdates++;
				}
			} else if (remoteChanged) {
				await this.replaceBody(existing, note.text);
				await this.app.fileManager.processFrontMatter(existing, (fm) => {
					fm["dashboard-sync-hash"] = hashText(note.text);
					fm["dashboard-updated-at"] = note.updatedAt ?? note.createdAt;
				});
				pulledUpdates++;
			} else if (localChanged && localBody.trim()) {
				const updated = await this.pushUpdate(note.id, localBody);
				await this.app.fileManager.processFrontMatter(existing, (fm) => {
					fm["dashboard-sync-hash"] = hashText(localBody);
					fm["dashboard-updated-at"] = updated.updatedAt ?? updated.createdAt;
				});
				pushedUpdates++;
			}
		}

		for (const file of localFiles) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (fm?.["dashboard-note-id"]) continue;
			const body = stripFrontmatter(await this.app.vault.read(file));
			if (!body.trim()) continue;
			const remote = await this.pushNew(body);
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				fm["dashboard-note-id"] = remote.id;
				fm["dashboard-sync-hash"] = hashText(body);
				fm["dashboard-updated-at"] = remote.updatedAt ?? remote.createdAt;
			});
			pushedNew++;
		}

		this.settings.lastSyncedAt = new Date().toISOString();
		await this.saveSettings();

		if (!silent) {
			new Notice(
				`Dashboard-Sync: ${created} neu geholt, ${pulledUpdates} aktualisiert (vom Dashboard), ` +
					`${pushedNew} neu gesendet, ${pushedUpdates} aktualisiert (zum Dashboard)` +
					`${conflicts ? `, ${conflicts} Konflikt(e) — lokale Version gewinnt` : ""}.`
			);
		}
	}
}

class DashboardSyncSettingTab extends PluginSettingTab {
	plugin: DashboardNotesSyncPlugin;

	constructor(app: App, plugin: DashboardNotesSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Dashboard-URL")
			.setDesc("Basis-URL des Dashboards, im LAN erreichbar (z.B. http://pie:3000).")
			.addText((text) =>
				text.setValue(this.plugin.settings.baseUrl).onChange(async (value) => {
					this.plugin.settings.baseUrl = value.trim() || DEFAULT_SETTINGS.baseUrl;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Sync-Ordner")
			.setDesc("Vault-interner Ordner, in dem synchronisierte Notizen als einzelne Dateien liegen.")
			.addText((text) =>
				text.setValue(this.plugin.settings.syncFolder).onChange(async (value) => {
					this.plugin.settings.syncFolder = value.trim() || DEFAULT_SETTINGS.syncFolder;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Beim Start synchronisieren")
			.setDesc("Versucht beim Öffnen des Vaults automatisch zu synchronisieren (schlägt lautlos fehl, falls nicht im LAN).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				})
			);

		const lastSync = this.plugin.settings.lastSyncedAt
			? new Date(this.plugin.settings.lastSyncedAt).toLocaleString()
			: "Noch nie";
		new Setting(containerEl)
			.setName("Jetzt synchronisieren")
			.setDesc(`Letzter Sync: ${lastSync}`)
			.addButton((btn) =>
				btn
					.setButtonText("Synchronisieren")
					.setCta()
					.onClick(async () => {
						await this.plugin.syncNow();
						this.display();
					})
			);

		containerEl.createEl("p", {
			text: 'Konflikte (beide Seiten seit dem letzten Sync geändert) werden zugunsten der lokalen (Obsidian-) Version aufgelöst.',
			cls: "setting-item-description",
		});
	}
}
