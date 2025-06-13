// main.ts - ENHANCED COMIC SEARCH PLUGIN (REVISED)
import { App, Plugin, PluginSettingTab, Setting, Modal, FuzzySuggestModal, Notice, TFile, FuzzyMatch, requestUrl, stringifyYaml, parseYaml, TFolder } from 'obsidian';

// ========================
// INTERFACES & TYPES
// ========================

interface DateTimeInfo {
    value?: string;
    year?: number;
    month?: number;
    day?: number;
    isApproximate?: boolean;
}

interface ComicSearchSettings {
    comicVineApiKey: string;
    comicsFolder: string;
    peopleFolder: string;
    defaultPageCount: number;
    enableReadingTracker: boolean;
    rateLimitDelay: number;
    createCreatorNotes: boolean;
    downloadComicImages: boolean;
    comicImagesFolder: string;
    downloadCreatorImages: boolean;
    creatorImagesFolder: string;
}

const DEFAULT_SETTINGS: ComicSearchSettings = {
    comicVineApiKey: '',
    comicsFolder: 'Comics',
    peopleFolder: 'Entities/People',
    defaultPageCount: 22,
    enableReadingTracker: true,
    rateLimitDelay: 1000,
    createCreatorNotes: true,
    downloadComicImages: false,
    comicImagesFolder: 'Assets/Comics',
    downloadCreatorImages: false,
    creatorImagesFolder: 'Assets/Creators',
};

type SearchResultItem = (ComicVineIssue & { resourceType: 'issue' }) | (ComicVineVolume & { resourceType: 'volume' });

interface ComicVineResponse<T> {
    error: string;
    status_code: number;
    results: T;
    number_of_total_results: number;
}

interface ComicVineIssue {
    id: number;
    name: string;
    issue_number: string;
    cover_date: string;
    store_date: string;
    description: string;
    deck: string;
    image: { super_url?: string; medium_url?: string; small_url?: string; };
    volume: { id: number; name: string; api_detail_url: string; };
    person_credits: Array<{ id: number; name: string; role: string; api_detail_url: string; }>;
    character_credits: Array<{ id: number; name: string; api_detail_url: string; }>;
    story_arc_credits: Array<{ id: number; name: string; api_detail_url: string; }>;
    site_detail_url: string;
    api_detail_url: string;
}

interface ComicVineVolume {
    id: number;
    name: string;
    start_year: string;
    publisher: { id: number; name: string; };
    count_of_issues: number;
    description: string;
    image: { super_url?: string; medium_url?: string; small_url?: string; };
    site_detail_url: string;
    api_detail_url: string;
    issues?: ComicVineIssue[];
}

interface ComicVinePerson {
    id: number;
    name: string;
    deck: string;
    description: string;
    birth: string | null;
    death: { date: string; } | null;
    site_detail_url: string;
    image: { super_url?: string; };
}

interface ComicIssueData {
    issue: ComicVineIssue;
    volume: ComicVineVolume;
    publisher: string;
    creators: Record<string, string[]>;
    characters: string[];
    storyArcs: string[];
    coverUrl?: string;
    deck?: string;
    comicVineUrl: string;
}

// ========================
// COMICVINE API CLIENT
// ========================
class ComicVineClient {
    private apiKey: string;
    private baseUrl = 'https://comicvine.gamespot.com/api';
    private lastRequestTime = 0;
    private rateLimitDelay: number;

    constructor(apiKey: string, rateLimitDelay: number) {
        this.apiKey = apiKey;
        this.rateLimitDelay = rateLimitDelay;
    }

    private async rateLimitedFetch(url: string, abortSignal?: AbortSignal): Promise<any> {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.rateLimitDelay) {
            await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay - timeSinceLastRequest));
        }
        this.lastRequestTime = Date.now();
        const response = await requestUrl({ url: url, headers: { 'User-Agent': 'ObsidianComicSearch/1.0' } });
        if (response.status !== 200) {
            throw new Error(`ComicVine API request failed with status ${response.status}`);
        }
        return response.json;
    }

    async search(query: string, abortSignal?: AbortSignal): Promise<SearchResultItem[]> {
        if (!this.apiKey) throw new Error('ComicVine API key not configured');
        const encodedQuery = encodeURIComponent(query);
        const url = `${this.baseUrl}/search/?api_key=${this.apiKey}&format=json&resources=issue,volume&query=${encodedQuery}&field_list=id,name,deck,image,resource_type,issue_number,cover_date,volume,start_year,publisher,count_of_issues&limit=20`;

        const response: ComicVineResponse<any[]> = await this.rateLimitedFetch(url, abortSignal);
        if (response.error !== 'OK') throw new Error(`ComicVine API error: ${response.error}`);
        return (response.results || []).map(r => ({ ...r, resourceType: r.resource_type }));
    }

    async getVolumeDetails(volumeId: number, includeIssues: boolean = false): Promise<ComicVineVolume> {
        let fieldList = 'id,name,start_year,publisher,count_of_issues,description,image,site_detail_url,api_detail_url';
        if (includeIssues) fieldList += ',issues';
        const url = `${this.baseUrl}/volume/4050-${volumeId}/?api_key=${this.apiKey}&format=json&field_list=${fieldList}`;
        const response: ComicVineResponse<ComicVineVolume> = await this.rateLimitedFetch(url);
        if (response.error !== 'OK') throw new Error(`ComicVine API error: ${response.error}`);
        return response.results;
    }

    async getIssueDetails(issueId: number): Promise<ComicVineIssue> {
        const url = `${this.baseUrl}/issue/4000-${issueId}/?api_key=${this.apiKey}&format=json&field_list=id,name,issue_number,cover_date,store_date,description,deck,image,volume,person_credits,character_credits,story_arc_credits,site_detail_url,api_detail_url`;
        const response: ComicVineResponse<ComicVineIssue> = await this.rateLimitedFetch(url);
        if (response.error !== 'OK') throw new Error(`ComicVine API error: ${response.error}`);
        return response.results;
    }

    async getPersonDetails(personApiUrl: string): Promise<ComicVinePerson> {
        const url = `${personApiUrl}?api_key=${this.apiKey}&format=json&field_list=id,name,deck,description,birth,death,site_detail_url,image`;
        const response: ComicVineResponse<ComicVinePerson> = await this.rateLimitedFetch(url);
        if (response.error !== 'OK') throw new Error(`ComicVine API error: ${response.error}`);
        return response.results;
    }
}

// ========================
// SEARCH MODAL
// ========================
class ComicSearchModal extends FuzzySuggestModal<SearchResultItem> {
    private plugin: ComicSearchPlugin;
    private client: ComicVineClient;
    private searchResults: SearchResultItem[] = [];
    private searchTimeout: NodeJS.Timeout | null = null;
    private abortController: AbortController | null = null;

    constructor(app: App, plugin: ComicSearchPlugin) {
        super(app);
        this.plugin = plugin;
        this.client = new ComicVineClient(plugin.settings.comicVineApiKey, plugin.settings.rateLimitDelay);
        this.setPlaceholder("Search for comics (issues or volumes)...");
        this.setInstructions([
            { command: "↑↓", purpose: "navigate" },
            { command: "↵", purpose: "select" },
            { command: "esc", purpose: "dismiss" }
        ]);
    }

    getItems(): SearchResultItem[] { 
        return this.searchResults; 
    }

    getSuggestions(query: string): FuzzyMatch<SearchResultItem>[] {
        return this.searchResults.map(item => ({
            item: item,
            match: { score: 0, matches: [] } // We are not using fuzzy search score here, just displaying API results
        }));
    }

    getItemText(item: SearchResultItem): string {
        if (item.resourceType === 'issue') {
            return `${item.volume.name} #${item.issue_number}${item.name ? ` - ${item.name}` : ''}`;
        } else {
            return `${item.name} (${item.start_year}) [Volume]`;
        }
    }

    renderSuggestion(match: FuzzyMatch<SearchResultItem>, el: HTMLElement) {
        const item = match.item;
        const container = el.createDiv({ cls: 'comic-search-suggestion' });
        const imageUrl = item.image?.small_url;
        if (imageUrl) {
            const imageContainer = container.createDiv({ cls: 'comic-search-image' });
            imageContainer.createEl('img', { cls: 'comic-cover-thumb', attr: { src: imageUrl } });
        }
        const textContainer = container.createDiv({ cls: 'comic-search-text' });
        if (item.resourceType === 'issue') {
            textContainer.createDiv({ cls: 'comic-search-title' }).setText(`${item.volume.name} #${item.issue_number}`);
            if (item.name && item.name !== item.volume.name) textContainer.createDiv({ cls: 'comic-search-subtitle', text: item.name });
            textContainer.createDiv({ cls: 'comic-search-meta', text: `${item.cover_date || 'Unknown date'}` });
            if (item.deck) textContainer.createDiv({ cls: 'comic-search-desc', text: item.deck.substring(0, 120) + '...' });
        } else {
            textContainer.createDiv({ cls: 'comic-search-title' }).setText(`${item.name}`);
            const pubName = item.publisher?.name || 'Unknown';
            textContainer.createDiv({ cls: 'comic-search-meta', text: `Volume • ${item.start_year} • ${pubName} • ${item.count_of_issues} issues` });
            if (item.description) textContainer.createDiv({ cls: 'comic-search-desc', text: this.plugin.cleanDescription(item.description).substring(0, 120) + '...' });
        }
    }

    async onChooseItem(item: SearchResultItem, evt: MouseEvent | KeyboardEvent) {
        this.cancelPendingSearch();
        this.close();
        try {
            if (item.resourceType === 'issue') {
                await this.plugin.createIssueNote(item as ComicVineIssue);
            } else {
                await this.plugin.createVolumeAndIssuesNotes(item as ComicVineVolume);
            }
        } catch (error) {
            new Notice(`Failed to create note: ${(error as Error).message}`);
            console.error('Failed to create note:', error);
        }
    }

    private cancelPendingSearch() {
        if (this.searchTimeout) { 
            clearTimeout(this.searchTimeout); 
            this.searchTimeout = null; 
        }
        if (this.abortController) { 
            this.abortController.abort(); 
            this.abortController = null;
        }
    }

    private async performSearch(query: string) {
        this.cancelPendingSearch();
        if (query.length < 3) {
            this.searchResults = [];
            (this as any).updateSuggestions();
            return;
        }

        this.abortController = new AbortController();
        try {
            const results = await this.client.search(query, this.abortController.signal);
            
            if (!this.abortController.signal.aborted) {
                this.searchResults = results;
                (this as any).updateSuggestions();
            }
        } catch (error) {
            if ((error as any).name !== 'AbortError') {
                console.error('Search failed:', error);
                new Notice(`Search failed: ${(error as Error).message}`);
            }
            this.searchResults = [];
            (this as any).updateSuggestions();
        }
    }

    onInput() {
        const query = this.inputEl.value.trim();
        this.cancelPendingSearch();
        
        if (query.length < 3) {
            this.searchResults = [];
            (this as any).updateSuggestions();
            return;
        }

        this.searchTimeout = setTimeout(() => {
            this.performSearch(query);
        }, 500); // Debounce search requests
    }

    onOpen() {
        super.onOpen();
        const styleId = 'comic-search-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .comic-search-suggestion { display: flex; padding: 8px 0; align-items: flex-start; gap: 12px; }
                .comic-search-image { flex-shrink: 0; width: 45px; }
                .comic-cover-thumb { width: 45px; height: auto; border-radius: 3px; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
                .comic-search-text { flex: 1; min-width: 0; }
                .comic-search-title { font-weight: bold; }
                .comic-search-subtitle { font-style: italic; color: var(--text-muted); }
                .comic-search-meta { font-size: 0.85em; color: var(--text-muted); }
                .comic-search-desc { font-size: 0.8em; color: var(--text-faint); margin-top: 4px; }
            `;
            document.head.appendChild(style);
        }
    }

    onClose() {
        super.onClose();
        this.cancelPendingSearch();
        const style = document.getElementById('comic-search-styles');
        if (style) style.remove();
    }
}

// ========================
// MAIN PLUGIN CLASS
// ========================
export default class ComicSearchPlugin extends Plugin {
    settings: ComicSearchSettings;

    async onload() {
        await this.loadSettings();
        this.addRibbonIcon('book-heart', 'Search Comics', () => new ComicSearchModal(this.app, this).open());
        this.addCommand({
            id: 'search-comics',
            name: 'Search for comics (issues & volumes)',
            callback: () => new ComicSearchModal(this.app, this).open(),
        });
        this.addSettingTab(new ComicSearchSettingTab(this.app, this));
    }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }

    async downloadImage(url: string, folder: string, fileName: string): Promise<string | null> {
        try {
            await this.ensureFolderExists(folder);
            const safeFileName = this.sanitizeForFileName(fileName);
            const filePath = `${folder}/${safeFileName}`;

            const existingFile = this.app.vault.getAbstractFileByPath(filePath);
            if (existingFile instanceof TFile) return existingFile.path;
            
            new Notice(`Downloading image: ${safeFileName}`, 2000);
            const response = await requestUrl({ url });
            const image_data = response.arrayBuffer;
            const newFile = await this.app.vault.createBinary(filePath, image_data);
            return newFile.path;
        } catch (error) {
            new Notice(`Failed to download image: ${fileName}`);
            console.error(`Image download error for ${url}:`, error);
            return null;
        }
    }
    
    async createVolumeAndIssuesNotes(volumeData: ComicVineVolume): Promise<void> {
        const client = new ComicVineClient(this.settings.comicVineApiKey, this.settings.rateLimitDelay);
        const sanitizedVolumeName = this.sanitizeForFileName(volumeData.name);
        const volumeFolderPath = `${this.settings.comicsFolder}/${sanitizedVolumeName}`;
        await this.ensureFolderExists(volumeFolderPath);

        new Notice(`Fetching details for volume: ${volumeData.name}`);
        const volume = await client.getVolumeDetails(volumeData.id, true);

        let localCoverPath: string | null = null;
        if (this.settings.downloadComicImages && volume.image?.super_url) {
            const fileName = `volume-${volume.id}-cover.jpg`;
            localCoverPath = await this.downloadImage(volume.image.super_url, this.settings.comicImagesFolder, fileName);
        }

        const volumeNoteContent = this.generateVolumeNoteContent(volume, localCoverPath);
        const volumeFilePath = `${volumeFolderPath}/${sanitizedVolumeName} (Compilation).md`;
        
        if (!this.app.vault.getAbstractFileByPath(volumeFilePath)) {
            await this.app.vault.create(volumeFilePath, volumeNoteContent);
            new Notice(`Created compilation note for ${volume.name}`);
        }

        if (!volume.issues || volume.issues.length === 0) {
            new Notice(`No individual issues found for ${volume.name}.`);
            return;
        }

        new Notice(`Found ${volume.issues.length} issues. Creating notes...`);
        let count = 0;
        for (const issueSummary of volume.issues.sort((a,b) => parseFloat(a.issue_number) - parseFloat(b.issue_number))) {
            const issueWithVolume: ComicVineIssue = {
                ...issueSummary,
                volume: { id: volume.id, name: volume.name, api_detail_url: volume.api_detail_url }
            };
            await this.createIssueNote(issueWithVolume, volumeFolderPath);
            count++;
            new Notice(`Processed issue #${issueSummary.issue_number} (${count}/${volume.issues.length})`, 1500);
        }
        new Notice(`Finished processing all issues for ${volume.name}.`);
    }

    async createIssueNote(issue: ComicVineIssue, targetFolder?: string): Promise<void> {
        try {
            const client = new ComicVineClient(this.settings.comicVineApiKey, this.settings.rateLimitDelay);
            const detailedIssue = await client.getIssueDetails(issue.id);
            const volume = await client.getVolumeDetails(issue.volume.id);
            
            let localCoverPath: string | null = null;
            if (this.settings.downloadComicImages && detailedIssue.image?.super_url) {
                const fileName = `issue-${detailedIssue.id}-cover.jpg`;
                localCoverPath = await this.downloadImage(detailedIssue.image.super_url, this.settings.comicImagesFolder, fileName);
            }

            const data = this.processIssueData(detailedIssue, volume, localCoverPath);
            const noteContent = this.generateIssueNoteContent(data);
            const fileName = this.generateFileName(data);
            const folderPath = targetFolder || this.settings.comicsFolder;
            await this.ensureFolderExists(folderPath);
            
            const filePath = `${folderPath}/${fileName}`;
            if (this.app.vault.getAbstractFileByPath(filePath)) {
                if (!targetFolder) new Notice(`Note for ${data.volume.name} #${data.issue.issue_number} already exists.`);
                return;
            }
            
            const file = await this.app.vault.create(filePath, noteContent);
            
            if (this.settings.createCreatorNotes) {
                await this.ensureCreatorNotesExist(detailedIssue.person_credits, file);
            }

            if (!targetFolder) {
                const leaf = this.app.workspace.getMostRecentLeaf();
                if (leaf) await leaf.openFile(file);
                new Notice(`Created note: ${fileName}`);
            }
        } catch (error) {
            console.error(`Error creating note for issue #${issue.issue_number}: `, error);
            new Notice(`Failed to create note for issue #${issue.issue_number}`);
        }
    }

    // ===============================================
    // NOTE GENERATION & HELPERS
    // ===============================================
    private generateVolumeNoteContent(volume: ComicVineVolume, localCoverPath?: string | null): string {
        const coverLink = localCoverPath ? `[[${this.app.vault.getAbstractFileByPath(localCoverPath)?.name}]]` : volume.image?.super_url || "";
        const now = new Date();
        
        const frontmatter: any = {
            entityType: "ComicVolume",
            name: volume.name,
            aliases: [],
            tags: ["comic-volume", this.sanitizeForTag(volume.publisher?.name || "unknown")],
            'creation date': now.toISOString(),
            'modification date': now.toISOString(),
            publisher: `[[${volume.publisher?.name || "Unknown"}]]`,
            startYear: volume.start_year,
            comicVineId: volume.id,
            comicVineUrl: volume.site_detail_url,
            coverUrl: coverLink,
            issueCount: volume.count_of_issues
        };

        const yaml = stringifyYaml(frontmatter);
        const coverEmbed = localCoverPath ? `![[${this.app.vault.getAbstractFileByPath(localCoverPath)?.name}|150]]` : (volume.image?.super_url ? `![cover|150](${volume.image.super_url})` : '');
        const description = volume.description ? `\n\n### Description\n${this.cleanDescription(volume.description)}` : '';
        return `---\n${yaml}---\n\n${coverEmbed}${description}\n\n### Contained Issues\n`;
    }

    private generateIssueNoteContent(data: ComicIssueData): string {
        const { coverUrl } = data;
        const coverIsLocal = coverUrl && !coverUrl.startsWith('http');
        const coverLink = coverIsLocal ? `[[${coverUrl.split('/').pop()}]]` : coverUrl || "";
        const frontmatter = this.generateIssueYAML(data, coverLink);
        
        const yaml = stringifyYaml(frontmatter);
        const coverEmbed = coverIsLocal ? `![[${coverUrl.split('/').pop()}|150]]` : (coverUrl ? `![cover|150](${coverUrl})` : '');
        const content = this.generateIssueMarkdown(data);

        return `---\n${yaml}---\n\n${coverEmbed}\n\n${content}`;
    }

    private generateIssueYAML(data: ComicIssueData, coverLink: string): any {
        const { issue, volume, publisher, creators, characters, storyArcs, deck, comicVineUrl } = data;
        const now = new Date();
        
        const frontmatter: any = {
            entityType: "ComicIssue",
            name: `${volume.name} #${issue.issue_number}`,
            aliases: issue.name ? [issue.name] : [],
            tags: ['comic-issue', this.sanitizeForTag(publisher), this.sanitizeForTag(volume.name)],
            'creation date': now.toISOString(),
            'modification date': now.toISOString(),
            volume: `[[${this.cleanForWikilink(volume.name)} (Compilation).md|${this.cleanForWikilink(volume.name)}]]`,
            issueNumber: this.quoteYamlString(issue.issue_number),
            publisher: `[[${this.cleanForWikilink(publisher)}]]`,
            coverDate: this.parseComicDate(issue.cover_date),
            storeDate: this.parseComicDate(issue.store_date),
            comicVineId: String(issue.id),
            comicVineUrl: comicVineUrl,
            coverUrl: coverLink,
            ...(deck && { description: this.quoteYamlString(deck) })
        };

        if (this.settings.enableReadingTracker) {
            frontmatter.pages = this.settings.defaultPageCount;
            frontmatter.currentPage = 0;
            frontmatter.percentComplete = 0;
            frontmatter.lastRead = null;
        }

        const ontologyCreators: Record<string, Set<string>> = {};
        for (const role in creators) {
            const ontologyKey = this.mapRoleToOntologyKey(role);
            if (!ontologyCreators[ontologyKey]) ontologyCreators[ontologyKey] = new Set();
            creators[role].forEach(person => ontologyCreators[ontologyKey].add(`[[${this.cleanForWikilink(person)}]]`));
        }
        Object.keys(ontologyCreators).sort().forEach(key => {
            frontmatter[key] = Array.from(ontologyCreators[key]);
        });

        if (characters.length > 0) frontmatter.features = characters.map(c => `[[${this.cleanForWikilink(c)}]]`);
        if (storyArcs.length > 0) frontmatter.partOfStoryArc = storyArcs.map(a => `[[${this.cleanForWikilink(a)}]]`);
        
        return frontmatter;
    }

    private parseComicDate(dateString: string): DateTimeInfo | null {
        if (!dateString) return null;
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return { value: dateString };
        return {
            value: dateString,
            year: date.getFullYear(),
            month: date.getMonth() + 1,
            day: date.getDate()
        };
    }
    
    private generateIssueMarkdown(data: ComicIssueData): string {
        const { issue, volume, publisher, creators, characters, storyArcs } = data;
        let content = `## ${volume.name} #${issue.issue_number}\n`;
        if (issue.name && issue.name !== volume.name) content += `*${issue.name}*\n\n`;
        else content += '\n';

        content += `**Published:** ${issue.cover_date}`;
        if (publisher) content += ` by [[${this.cleanForWikilink(publisher)}]]`;
        content += '\n\n';

        if (Object.keys(creators).length > 0) {
            content += `### Creative Team\n`;
            Object.keys(creators).sort(this.sortRoles).forEach(role => {
                creators[role].forEach(person => {
                    content += `- **${role}:** [[${this.cleanForWikilink(person)}]]\n`;
                });
            });
            content += '\n';
        }

        if (characters.length > 0) {
            content += `### Characters\n`;
            characters.forEach(c => content += `- [[${this.cleanForWikilink(c)}]]\n`);
            content += '\n';
        }

        if (storyArcs.length > 0) {
            content += `### Story Arc\n`;
            storyArcs.forEach(a => content += `- Part of: [[${this.cleanForWikilink(a)}]]\n`);
            content += '\n';
        }

        if (issue.description) content += `### Description\n${this.cleanDescription(issue.description)}\n\n`;
        else if (issue.deck) content += `### Description\n${issue.deck}\n\n`;

        content += `### Reading Notes\n*Add your thoughts here...*\n\n`;
        return content;
    }

    private mapRoleToOntologyKey(role: string): string {
        const roleLower = role.toLowerCase().trim();
        const mapping: Record<string, string> = {
            'writer': 'writtenBy', 'script': 'writtenBy', 'editor': 'editedBy',
            'penciler': 'penciler', 'penciller': 'penciler', 'inker': 'inker',
            'colorist': 'colorist', 'letterer': 'letterer',
            'cover artist': 'coverArtist', 'cover': 'coverArtist',
            'artist': 'contributedTo', 'creator': 'creator',
        };
        return mapping[roleLower] || 'contributedTo'; // Default to a general contribution
    }
    
    private sortRoles(a: string, b: string): number {
        const order = ['Writer', 'Script', 'Creator', 'Penciler', 'Artist', 'Inker', 'Colorist', 'Letterer', 'Editor', 'Cover Artist'];
        const indexA = order.indexOf(a);
        const indexB = order.indexOf(b);
        if (indexA !== -1 && indexB !== -1) return indexA - indexB;
        if (indexA !== -1) return -1;
        if (indexB !== -1) return 1;
        return a.localeCompare(b);
    }
    
    private quoteYamlString(value: any): string {
        if (value == null) return '';
        const strValue = String(value);
        if (/[#:]/.test(strValue) || ['true', 'false', 'null'].includes(strValue.toLowerCase())) {
            return `"${strValue.replace(/"/g, '\\"')}"`;
        }
        return strValue;
    }

    cleanForWikilink(text: string): string {
        return text.replace(/[\[\]|#^]/g, '').trim();
    }

    private parseCreatorDate(dateString: string | null): DateTimeInfo | null {
        if (!dateString || typeof dateString !== 'string') return null;
        const date = new Date(dateString);
        if (!isNaN(date.getTime())) {
            const year = date.getUTCFullYear();
            if (year < 100) return { value: dateString };
            const month = date.getUTCMonth() + 1;
            const day = date.getUTCDate();
            const info: DateTimeInfo = { value: dateString, year: year };
            if (dateString.match(/^\d{4}$/)) return { value: dateString, year: year };
            if (dateString.match(/^\d{4}-\d{2}$/)) { info.month = month; return info; }
            info.month = month; info.day = day; return info;
        }
        return { value: dateString };
    }

    private async findPersonNote(creatorId: number, creatorName: string): Promise<TFile | undefined> {
        const peopleFolder = this.settings.peopleFolder;
        const folder = this.app.vault.getAbstractFileByPath(peopleFolder);

        if (!(folder instanceof TFolder)) return undefined;

        for (const file of folder.children) {
            if (file instanceof TFile) {
                const cache = this.app.metadataCache.getFileCache(file);
                if (cache?.frontmatter?.comicVineId === creatorId) {
                    return file;
                }
            }
        }
        // Fallback to name-based search if ID not found
        const nameBasedPath = `${peopleFolder}/${this.sanitizeForFileName(creatorName)}.md`;
        const fileByName = this.app.vault.getAbstractFileByPath(nameBasedPath);
        if (fileByName instanceof TFile) return fileByName;
        return undefined;
    }

    private async ensureCreatorNotesExist(creators: ComicVineIssue['person_credits'], issueFile: TFile): Promise<void> {
        if (!this.settings.createCreatorNotes || !creators || creators.length === 0) return;
    
        const client = new ComicVineClient(this.settings.comicVineApiKey, this.settings.rateLimitDelay);
        const creatorsFolder = this.settings.peopleFolder;
        await this.ensureFolderExists(creatorsFolder);
    
        const uniqueCreators = new Map<number, { id: number; name: string; api_detail_url: string; roles: string[] }>();
        creators.forEach(c => {
            const existing = uniqueCreators.get(c.id);
            if (existing) {
                existing.roles.push(...c.role.split(',').map(r => r.trim()));
            } else {
                uniqueCreators.set(c.id, { ...c, roles: c.role.split(',').map(r => r.trim()) });
            }
        });
    
        for (const creator of uniqueCreators.values()) {
            let changed = false;
            let personFile = await this.findPersonNote(creator.id, creator.name);
            let frontmatter: any;
            let body: string;
    
            if (personFile) {
                const parsed = this.parseFrontmatter(await this.app.vault.read(personFile));
                frontmatter = parsed.frontmatter;
                body = parsed.body;
            } else {
                frontmatter = {};
                body = `# ${creator.name}\n\n`;
            }
    
            try {
                new Notice(`Processing creator: ${creator.name}...`, 2000);
                const personDetails = await client.getPersonDetails(creator.api_detail_url);
    
                const now = new Date();
                // REVISED LOGIC: Set entityType to "Person"
                if (!frontmatter.entityType || frontmatter.entityType === "ComicCreator") { frontmatter.entityType = "Person"; changed = true; }
                if (!frontmatter.name) { frontmatter.name = personDetails.name; changed = true; }
                if (!frontmatter.comicVineId) { frontmatter.comicVineId = personDetails.id; changed = true; }
                if (!frontmatter.comicVineUrl) { frontmatter.comicVineUrl = personDetails.site_detail_url; changed = true; }
                
                if (!personFile) {
                    frontmatter.aliases = [];
                    // REVISED LOGIC: Add both tags for context
                    frontmatter.tags = ['person', 'comic-creator'];
                    frontmatter['creation date'] = now.toISOString();
                    changed = true;
                }
                frontmatter['modification date'] = now.toISOString();
    
                const birthInfo = this.parseCreatorDate(personDetails.birth);
                if (birthInfo && !frontmatter.birthDate) { frontmatter.birthDate = birthInfo; changed = true; }
    
                const deathInfo = this.parseCreatorDate(personDetails.death?.date || null);
                if (deathInfo && !frontmatter.deathDate) { frontmatter.deathDate = deathInfo; changed = true; }

                let localImagePath: string | null = null;
                if (this.settings.downloadCreatorImages && personDetails.image?.super_url) {
                    const fileName = `person-${personDetails.id}-photo.jpg`;
                    localImagePath = await this.downloadImage(personDetails.image.super_url, this.settings.creatorImagesFolder, fileName);
                    if (localImagePath && !frontmatter.image) {
                        frontmatter.image = `[[${this.app.vault.getAbstractFileByPath(localImagePath)?.name}]]`;
                        changed = true;
                    }
                }
    
            } catch (error) {
                new Notice(`Failed to fetch details for ${creator.name}.`, 5000);
                console.error(`Failed to process creator ${creator.name} (ID: ${creator.id}):`, error);
                continue;
            }
    
            if (!frontmatter.roles) frontmatter.roles = [];
            if (!frontmatter.credits) frontmatter.credits = [];
            if (!frontmatter.tags) frontmatter.tags = [];
    
            if (!frontmatter.tags.includes('person')) {
                frontmatter.tags.push('person');
                changed = true;
            }
            if (!frontmatter.tags.includes('comic-creator')) {
                frontmatter.tags.push('comic-creator');
                changed = true;
            }
    
            for (const roleName of new Set(creator.roles)) {
                if (!roleName) continue;
                const roleNote = await this.getOrCreateRoleNote(roleName);
                const roleLink = `[[${roleNote.basename}]]`;
    
                if (!frontmatter.roles.includes(roleLink)) {
                    frontmatter.roles.push(roleLink);
                    changed = true;
                }
    
                const issueLink = `[[${issueFile.basename}]]`;
                const newCredit = { role: roleLink, work: issueLink };
                const creditExists = frontmatter.credits.some((c: any) => c.role === newCredit.role && c.work === newCredit.work);
    
                if (!creditExists) {
                    frontmatter.credits.push(newCredit);
                    changed = true;
                }
            }
    
            if (changed) {
                frontmatter.roles.sort();
                frontmatter['modification date'] = new Date().toISOString();
                const newContent = this.buildFrontmatter(frontmatter, body);
    
                if (personFile) {
                    await this.app.vault.modify(personFile, newContent);
                } else {
                    const personFileName = this.sanitizeForFileName(creator.name) + '.md';
                    const personFilePath = `${creatorsFolder}/${personFileName}`;
                    personFile = await this.app.vault.create(personFilePath, newContent);
                }
            }
        }
    }

    private async getOrCreateRoleNote(roleName: string): Promise<TFile> {
        const capitalizedRole = roleName.charAt(0).toUpperCase() + roleName.slice(1).trim();
        const filename = this.sanitizeForFileName(capitalizedRole) + ' (Role).md';
        const conceptsFolder = `${this.settings.comicsFolder}/Concepts`;
        await this.ensureFolderExists(conceptsFolder);

        const filepath = `${conceptsFolder}/${filename}`;
        let file = this.app.vault.getAbstractFileByPath(filepath) as TFile;

        if (!file) {
            const now = new Date();
            const frontmatter: any = {
                entityType: "RoleConcept",
                name: capitalizedRole,
                aliases: [],
                tags: ['concept', 'role'],
                'creation date': now.toISOString(),
                'modification date': now.toISOString(),
                description: `A creative role in comic book production: ${capitalizedRole}`
            };
            
            const roleHierarchy: Record<string, string> = {
                'Penciler': 'Artist', 'Penciller': 'Artist', 'Inker': 'Artist',
                'Colorist': 'Artist', 'Cover artist': 'Artist', 'Script': 'Writer'
            };
            if (roleHierarchy[capitalizedRole]) {
                const parentRoleName = roleHierarchy[capitalizedRole];
                const parentRoleNote = await this.getOrCreateRoleNote(parentRoleName);
                frontmatter.subConceptOf = `[[${parentRoleNote.basename}]]`;
            }
            const content = this.buildFrontmatter(frontmatter, `# ${capitalizedRole}\n\n## People with this Role\n\n`);
            file = await this.app.vault.create(filepath, content);
            new Notice(`Created role note: ${filename}`);
        }
        return file;
    }

    private parseFrontmatter(content: string): { frontmatter: any, body: string } {
        const frontmatterMatch = content.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*[\r\n]?([\s\S]*)$/);
        if (frontmatterMatch) {
            try {
                const frontmatter = parseYaml(frontmatterMatch[1]);
                return { frontmatter: typeof frontmatter === 'object' && frontmatter !== null ? frontmatter : {}, body: frontmatterMatch[2] || '' };
            } catch (error: any) {
                new Notice(`Failed to parse YAML frontmatter: ${(error as Error).message}.`);
                return { frontmatter: {}, body: content };
            }
        }
        return { frontmatter: {}, body: content };
    }

    private buildFrontmatter(frontmatter: any, body: string): string {
        const cleanFrontmatter: any = {};
        for (const key in frontmatter) {
            if (frontmatter[key] !== undefined) {
                 cleanFrontmatter[key] = frontmatter[key];
            }
        }
        if (Object.keys(cleanFrontmatter).length === 0) return body.trimStart(); 
        
        let yamlString;
        try {
            yamlString = stringifyYaml(cleanFrontmatter);
        } catch (e: any) {
            new Notice(`Error stringifying YAML: ${(e as Error).message}`);
            console.error("Error stringifying YAML:", cleanFrontmatter, e);
            return `---\n# YAML ERROR - CHECK CONSOLE\n---\n${body.trimStart()}`;
        }
        const trimmedYaml = yamlString.trim(); 
        return `---\n${trimmedYaml}\n---\n${body.trimStart()}`;
    }

    private processIssueData(issue: ComicVineIssue, volume: ComicVineVolume, localCoverPath?: string | null): ComicIssueData {
        const creators: Record<string, string[]> = {};
        issue.person_credits?.forEach(credit => {
            const roles = credit.role.split(',').map(r => r.trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
            roles.forEach(role => {
                if (!role) return;
                if (!creators[role]) creators[role] = [];
                if (!creators[role].includes(credit.name)) creators[role].push(credit.name);
            });
        });
        return {
            issue,
            volume,
            publisher: volume.publisher?.name || 'Unknown Publisher',
            creators,
            characters: issue.character_credits?.map(c => c.name) || [],
            storyArcs: issue.story_arc_credits?.map(s => s.name) || [],
            coverUrl: localCoverPath || issue.image?.super_url,
            deck: issue.deck,
            comicVineUrl: issue.site_detail_url
        };
    }

    sanitizeForFileName(name: string): string { return name.replace(/[<>:"/\\|?*#^|[\]]/g, '').trim(); }
    private generateFileName(data: ComicIssueData): string {
        const vol = this.sanitizeForFileName(data.volume.name);
        const num = String(data.issue.issue_number).padStart(3, '0');
        return `${vol} #${num}.md`;
    }
    private sanitizeForTag(text: string): string { return text.replace(/[^a-zA-Z0-9-]/g, '').replace(/\s+/g, '-').toLowerCase(); }
    cleanDescription(desc: string): string { return desc.replace(/<[^>]*>/g, '\n').replace(/\n\s*\n/g, '\n\n').trim(); }
    async ensureFolderExists(path: string): Promise<void> { 
        if (!this.app.vault.getAbstractFileByPath(path)) {
            await this.app.vault.createFolder(path);
        }
    }
}

// ========================
// SETTINGS TAB
// ========================
class ComicSearchSettingTab extends PluginSettingTab {
    plugin: ComicSearchPlugin;
    constructor(app: App, plugin: ComicSearchPlugin) { super(app, plugin); this.plugin = plugin; }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Comic Search Settings' });
        
        containerEl.createEl('h3', { text: 'API Configuration' });
        new Setting(containerEl).setName('ComicVine API Key').setDesc('Get your free API key from ComicVine.').addText(text => text.setPlaceholder('Enter your API key').setValue(this.plugin.settings.comicVineApiKey).onChange(async (value) => { this.plugin.settings.comicVineApiKey = value; await this.plugin.saveSettings(); }));

        containerEl.createEl('h3', { text: 'File & Note Configuration' });
        new Setting(containerEl).setName('Comics Folder').addText(text => text.setPlaceholder('Comics').setValue(this.plugin.settings.comicsFolder).onChange(async (value) => { this.plugin.settings.comicsFolder = value || 'Comics'; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('People Folder').setDesc('Shared folder for all person notes (comic creators, musicians, etc.).').addText(text => text.setPlaceholder('Entities/People').setValue(this.plugin.settings.peopleFolder).onChange(async (value) => { this.plugin.settings.peopleFolder = value || 'Entities/People'; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Create/Update Creator Notes').setDesc('Automatically create or update notes for comic creators in your People Folder.').addToggle(toggle => toggle.setValue(this.plugin.settings.createCreatorNotes).onChange(async (value) => { this.plugin.settings.createCreatorNotes = value; await this.plugin.saveSettings(); }));

        containerEl.createEl('h3', { text: 'Image Downloading' });
        new Setting(containerEl).setName('Download comic covers').setDesc('Automatically download and save cover images.').addToggle(toggle => toggle.setValue(this.plugin.settings.downloadComicImages).onChange(async (value) => { this.plugin.settings.downloadComicImages = value; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Comic images folder').addText(text => text.setPlaceholder('Assets/Comics').setValue(this.plugin.settings.comicImagesFolder).onChange(async (value) => { this.plugin.settings.comicImagesFolder = value || 'Assets/Comics'; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Download creator photos').setDesc('Automatically download and save photos for creators.').addToggle(toggle => toggle.setValue(this.plugin.settings.downloadCreatorImages).onChange(async (value) => { this.plugin.settings.downloadCreatorImages = value; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Creator images folder').addText(text => text.setPlaceholder('Assets/Creators').setValue(this.plugin.settings.creatorImagesFolder).onChange(async (value) => { this.plugin.settings.creatorImagesFolder = value || 'Assets/Creators'; await this.plugin.saveSettings(); }));

        containerEl.createEl('h3', { text: 'Tracker Configuration' });
        new Setting(containerEl).setName('Default Page Count').addText(text => text.setPlaceholder('22').setValue(String(this.plugin.settings.defaultPageCount)).onChange(async (value) => { const num = parseInt(value); if (!isNaN(num) && num > 0) this.plugin.settings.defaultPageCount = num; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Reading Tracker Integration').addToggle(toggle => toggle.setValue(this.plugin.settings.enableReadingTracker).onChange(async (value) => { this.plugin.settings.enableReadingTracker = value; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Rate Limit Delay (ms)').setDesc('Delay between API requests to respect ComicVine rate limits (min 500).').addText(text => text.setPlaceholder('1000').setValue(String(this.plugin.settings.rateLimitDelay)).onChange(async (value) => { const num = parseInt(value); if (!isNaN(num) && num >= 500) this.plugin.settings.rateLimitDelay = num; await this.plugin.saveSettings(); }));
    }
}
