// main.ts - Comic Search Plugin Phase 7 - Correct Death Date Parsing
import { App, Plugin, PluginSettingTab, Setting, Modal, FuzzySuggestModal, Notice, TFile, FuzzyMatch, requestUrl } from 'obsidian';

// ========================
// INTERFACES & TYPES
// ========================

interface ComicSearchSettings {
    comicVineApiKey: string;
    comicsFolder: string;
    defaultPageCount: number;
    enableReadingTracker: boolean;
    rateLimitDelay: number;
    createCreatorNotes: boolean;
}

const DEFAULT_SETTINGS: ComicSearchSettings = {
    comicVineApiKey: '',
    comicsFolder: 'Comics',
    defaultPageCount: 22,
    enableReadingTracker: true,
    rateLimitDelay: 1000,
    createCreatorNotes: true,
};

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
    image: {
        super_url?: string;
        medium_url?: string;
        small_url?: string;
    };
    volume: {
        id: number;
        name: string;
        api_detail_url: string;
    };
    person_credits: Array<{
        id: number;
        name: string;
        role: string;
        api_detail_url: string;
    }>;
    character_credits: Array<{
        id: number;
        name: string;
        api_detail_url: string;
    }>;
    story_arc_credits: Array<{
        id: number;
        name: string;
        api_detail_url: string;
    }>;
    site_detail_url: string;
    api_detail_url: string;
}

interface ComicVineVolume {
    id: number;
    name: string;
    start_year: number;
    publisher: {
        id: number;
        name: string;
    };
    count_of_issues: number;
    description: string;
    image: {
        super_url?: string;
    };
}

// UPDATED: Correct interface for the person response
interface ComicVinePerson {
    id: number;
    name: string;
    deck: string;
    description: string;
    birth: string | null;
    death: {
        date: string;
        timezone_type: number;
        timezone: string;
    } | null;
    site_detail_url: string;
    image: {
        super_url?: string;
    };
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

    constructor(apiKey: string, rateLimitDelay: number = 1000) {
        this.apiKey = apiKey;
        this.rateLimitDelay = rateLimitDelay;
    }

    private async rateLimitedFetch(url: string, abortSignal?: AbortSignal): Promise<any> {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.rateLimitDelay) {
            const delay = this.rateLimitDelay - timeSinceLastRequest;
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(resolve, delay);
                
                if (abortSignal) {
                    abortSignal.addEventListener('abort', () => {
                        clearTimeout(timeout);
                        reject(new Error('Request aborted'));
                    });
                }
            });
        }

        if (abortSignal?.aborted) {
            throw new Error('Request aborted');
        }

        this.lastRequestTime = Date.now();
        
        try {
            const response = await requestUrl({
                url: url,
                headers: { 'User-Agent': 'ObsidianComicSearch/1.0' }
            });
            return response.json;
        } catch (error) {
            console.error("ComicVine API request failed:", error);
            if (error.status) throw new Error(`API request failed: Status ${error.status}`);
            throw new Error(`API request failed: ${error.message}`);
        }
    }

    async searchIssues(query: string, abortSignal?: AbortSignal): Promise<ComicVineIssue[]> {
        if (!this.apiKey) throw new Error('ComicVine API key not configured');
        const encodedQuery = encodeURIComponent(query);
        const url = `${this.baseUrl}/search/?api_key=${this.apiKey}&format=json&resources=issue&query=${encodedQuery}&field_list=id,name,issue_number,cover_date,volume,image,deck&limit=10`;

        try {
            const response: ComicVineResponse<ComicVineIssue[]> = await this.rateLimitedFetch(url, abortSignal);
            if (response.error !== 'OK') throw new Error(`ComicVine API error: ${response.error}`);
            return response.results || [];
        } catch (error) {
            if (error.message === 'Request aborted') throw error;
            console.error('ComicVine search failed:', error);
            throw error;
        }
    }

    async getIssueDetails(issueId: number): Promise<ComicVineIssue> {
        const url = `${this.baseUrl}/issue/4000-${issueId}/?api_key=${this.apiKey}&format=json&field_list=id,name,issue_number,cover_date,store_date,description,deck,image,volume,person_credits,character_credits,story_arc_credits,site_detail_url,api_detail_url`;

        try {
            const response: ComicVineResponse<ComicVineIssue> = await this.rateLimitedFetch(url);
            if (response.error !== 'OK') throw new Error(`ComicVine API error: ${response.error}`);
            return response.results;
        } catch (error) {
            console.error('Failed to get issue details:', error);
            throw error;
        }
    }

    async getVolumeDetails(volumeId: number): Promise<ComicVineVolume> {
        const url = `${this.baseUrl}/volume/4050-${volumeId}/?api_key=${this.apiKey}&format=json&field_list=id,name,start_year,publisher,count_of_issues,description,image`;
        try {
            const response: ComicVineResponse<ComicVineVolume> = await this.rateLimitedFetch(url);
            if (response.error !== 'OK') throw new Error(`ComicVine API error: ${response.error}`);
            return response.results;
        } catch (error) {
            console.error('Failed to get volume details:', error);
            throw error;
        }
    }

    async getPersonDetails(personApiUrl: string): Promise<ComicVinePerson> {
        const url = `${personApiUrl}?api_key=${this.apiKey}&format=json&field_list=id,name,deck,description,birth,death,site_detail_url,image`;
        try {
            const response: ComicVineResponse<ComicVinePerson> = await this.rateLimitedFetch(url);
            if (response.error !== 'OK') throw new Error(`ComicVine API error: ${response.error}`);
            return response.results;
        } catch (error) {
            console.error('Failed to get person details:', error);
            throw error;
        }
    }
}

// ========================
// NOTE GENERATOR
// ========================
class ComicNoteGenerator {
    private settings: ComicSearchSettings;

    constructor(settings: ComicSearchSettings) {
        this.settings = settings;
    }

    generateIssueNote(data: ComicIssueData): string {
        const yaml = this.generateYAML(data);
        const content = this.generateContent(data);
        return `---\n${yaml}\n---\n\n${content}`;
    }

    generateCreatorNote(person: ComicVinePerson): string {
        const yaml = this.generateCreatorYAML(person);
        const content = this.generateCreatorContent(person);
        return `---\n${yaml}\n---\n\n${content}`;
    }

    private parseCreatorDate(dateString: string | null): { year: number, month?: number, day?: number } | null {
        if (!dateString || typeof dateString !== 'string') {
            return null;
        }
    
        const parsedDate = new Date(dateString);
        if (!isNaN(parsedDate.getTime()) && parsedDate.getUTCFullYear() > 1) {
            return {
                year: parsedDate.getUTCFullYear(),
                month: parsedDate.getUTCMonth() + 1,
                day: parsedDate.getUTCDate()
            };
        }
    
        const parts = dateString.split('-');
        if (parts.length >= 1) {
            const year = parseInt(parts[0], 10);
            if (!isNaN(year)) {
                const result: { year: number, month?: number, day?: number } = { year };
                if (parts.length > 1) {
                    const month = parseInt(parts[1], 10);
                    if (month > 0) result.month = month;
                }
                if (parts.length > 2) {
                    const day = parseInt(parts[2], 10);
                    if (day > 0) result.day = day;
                }
                return result;
            }
        }
    
        return null;
    }

    private generateCreatorYAML(person: ComicVinePerson): string {
        let yaml = `entityType: ComicCreator\n`;
        yaml += `name: ${this.quoteYamlString(person.name)}\n`;

        const birthInfo = this.parseCreatorDate(person.birth);
        if (birthInfo) {
            yaml += `birthDate:\n`;
            yaml += `  year: ${birthInfo.year}\n`;
            if (birthInfo.month) yaml += `  month: ${birthInfo.month}\n`;
            if (birthInfo.day) yaml += `  day: ${birthInfo.day}\n`;
        }

        // UPDATED: Check for the nested death object and its 'date' property
        const deathDateString = (person.death && typeof person.death === 'object' && person.death.date) 
                                ? person.death.date 
                                : null;
        const deathInfo = this.parseCreatorDate(deathDateString);
        if (deathInfo) {
            yaml += `deathDate:\n`;
            yaml += `  year: ${deathInfo.year}\n`;
            if (deathInfo.month) yaml += `  month: ${deathInfo.month}\n`;
            if (deathInfo.day) yaml += `  day: ${deathInfo.day}\n`;
        }

        yaml += `comicVineId: ${person.id}\n`;
        yaml += `comicVineUrl: ${person.site_detail_url}\n`;
        yaml += `tags:\n  - comic-creator\n`;
        return yaml;
    }

    private generateCreatorContent(person: ComicVinePerson): string {
        let content = '';
        if (person.image?.super_url) {
            content += `![image|150](${person.image.super_url})\n\n`;
        }
        
        content += `# ${person.name}\n\n`;
        
        content += `## Works\n`;
        content += `*This section can be populated by other plugins or backlinks.*\n\n`;
        
        content += `### References\n`;
        content += `- [ComicVine Profile](${person.site_detail_url})\n`;
        
        return content;
    }
    
    private mapRoleToOntologyKey(role: string): string {
        const roleLower = role.toLowerCase().trim();
        const mapping: Record<string, string> = {
            'writer': 'writtenBy', 'script': 'writtenBy', 'editor': 'editedBy',
            'penciler': 'penciler', 'penciller': 'penciler', 'inker': 'inker',
            'colorist': 'colorist', 'letterer': 'letterer',
            'cover artist': 'coverArtist', 'cover': 'coverArtist',
            'artist': 'contributedTo',
        };
        if (mapping[roleLower]) return mapping[roleLower];
        let key = role.charAt(0).toLowerCase() + role.slice(1);
        return key.replace(/\s+/g, '');
    }

    private generateYAML(data: ComicIssueData): string {
        const { issue, volume, publisher, creators, characters, storyArcs, coverUrl, deck, comicVineUrl } = data;
        let yaml = '';
        if (this.settings.enableReadingTracker) {
            yaml += `entityType: ComicIssue\n`;
            yaml += `title: ${this.quoteYamlString(`${volume.name} #${issue.issue_number}`)}\n`;
            yaml += `pages: ${this.settings.defaultPageCount}\n`;
            yaml += `currentPage: 0\n`;
            yaml += `percentComplete: 0\n`;
            yaml += `lastRead:\n`;
            yaml += `type: comic\n\n`;
        }
        yaml += `# Comic Metadata\n`;
        yaml += `volume: ${this.formatWikilink(volume.name)}\n`;
        yaml += `issueNumber: ${this.quoteYamlString(issue.issue_number)}\n`;
        yaml += `publisher: ${this.formatWikilink(publisher)}\n`;
        yaml += `publicationDate: ${this.quoteYamlString(issue.cover_date)}\n`;
        if (issue.store_date) yaml += `storeDate: ${this.quoteYamlString(issue.store_date)}\n`;
        if (deck) yaml += `deck: ${this.quoteYamlString(deck)}\n`;
        if (coverUrl) yaml += `coverUrl: ${coverUrl}\n`;
        yaml += `comicVineId: ${String(issue.id)}\n`;
        yaml += `comicVineUrl: ${comicVineUrl}\n`;
        if (volume.start_year) yaml += `volumeStartYear: ${volume.start_year}\n`;
        yaml += '\n';
        if (Object.keys(creators).length > 0) {
            yaml += `# Creators\n`;
            const ontologyCreators: Record<string, Set<string>> = {};
            for (const role in creators) {
                const people = creators[role];
                const ontologyKey = this.mapRoleToOntologyKey(role);
                if (!ontologyCreators[ontologyKey]) ontologyCreators[ontologyKey] = new Set();
                people.forEach(person => ontologyCreators[ontologyKey].add(person));
            }
            const sortedKeys = Object.keys(ontologyCreators).sort();
            sortedKeys.forEach(key => {
                const peopleArray = Array.from(ontologyCreators[key]);
                yaml += this.formatYamlList(peopleArray, key, true);
            });
            yaml += '\n';
        }
        if (characters.length > 0) {
            yaml += `# Characters\n`;
            yaml += this.formatYamlList(characters, 'features', true);
            yaml += '\n';
        }
        if (storyArcs.length > 0) {
            yaml += `# Story Arcs\n`;
            yaml += this.formatYamlList(storyArcs, 'partOfStoryArc', true);
            yaml += '\n';
        }
        yaml += `tags:\n`;
        yaml += `  - comic\n`;
        yaml += `  - ${this.sanitizeForTag(publisher)}\n`;
        yaml += `  - ${this.sanitizeForTag(volume.name)}\n`;
        return yaml;
    }

    private sortRoles(a: string, b: string): number {
        const order = ['Writer', 'Script', 'Penciler', 'Artist', 'Inker', 'Colorist', 'Letterer', 'Editor', 'Cover Artist'];
        const indexA = order.indexOf(a);
        const indexB = order.indexOf(b);
        if (indexA !== -1 && indexB !== -1) return indexA - indexB;
        if (indexA !== -1) return -1;
        if (indexB !== -1) return 1;
        return a.localeCompare(b);
    }

    private formatYamlList(items: string[], key: string, createWikilinks: boolean): string {
        if (!items || items.length === 0) return '';
        let yaml = `${key}:\n`;
        items.forEach(item => {
            const cleanItem = this.cleanForWikilink(item);
            const value = createWikilinks ? `[[${cleanItem}]]` : cleanItem;
            yaml += `  - ${this.quoteYamlString(value)}\n`;
        });
        return yaml;
    }
    
    private formatWikilink(text: string): string {
        if (!text) return '""';
        const cleanText = this.cleanForWikilink(text);
        const wikilink = `[[${cleanText}]]`;
        return this.quoteYamlString(wikilink);
    }

    private cleanForWikilink(text: string): string {
        return text.replace(/<[^>]*>/g, '').replace(/^["']|["']$/g, '').replace(/\|/g, ' - ').replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim();
    }

    private quoteYamlString(value: any): string {
        if (value == null) return '""';
        value = String(value);

        const needsQuoting = /[:\[\]{}|>@`"'\\#&*!?\-%]|^\s|\s$|^-|^[0-9]/.test(value) || ['true', 'false', 'null', 'yes', 'no'].includes(value.toLowerCase());
        if (!needsQuoting && !value.startsWith('[[')) return value;
        if (value.includes('\n')) return '|\n  ' + value.split('\n').join('\n  ');
        return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }

    private sanitizeForTag(text: string): string {
        return text.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').toLowerCase().replace(/^-+|-+$/g, '').replace(/-+/g, '-') || 'unknown';
    }

    private generateContent(data: ComicIssueData): string {
        const { issue, volume, publisher, creators, characters, storyArcs } = data;
        let content = '';
        if (issue.image?.super_url) content += `![cover|150](${issue.image.super_url})\n\n`;
        content += `## ${volume.name} #${issue.issue_number}\n`;
        if (issue.name && issue.name !== volume.name) content += `*${issue.name}*\n\n`;
        else content += '\n';
        content += `**Published:** ${issue.cover_date}`;
        if (publisher) content += ` by [[${this.cleanForWikilink(publisher)}]]`;
        content += '\n\n';
        if (Object.keys(creators).length > 0) {
            content += `### Creative Team\n`;
            const sortedRoles = Object.keys(creators).sort(this.sortRoles);
            sortedRoles.forEach(role => {
                creators[role].forEach(person => {
                    content += `- **${role}:** [[${this.cleanForWikilink(person)}]]\n`;
                });
            });
            content += '\n';
        }
        if (characters.length > 0) {
            content += `### Characters\n`;
            characters.forEach(character => content += `- [[${this.cleanForWikilink(character)}]]\n`);
            content += '\n';
        }
        if (storyArcs.length > 0) {
            content += `### Story Arc\n`;
            storyArcs.forEach(arc => content += `- Part of: [[${this.cleanForWikilink(arc)}]]\n`);
            content += '\n';
        }
        if (issue.description) content += `### Description\n${this.cleanDescription(issue.description)}\n\n`;
        else if (issue.deck) content += `### Description\n${issue.deck}\n\n`;
        content += `### Reading Notes\n*Add your thoughts here...*\n\n`;
        content += `### Key Events\n- \n\n`;
        content += `### References\n- [ComicVine](${issue.site_detail_url})\n`;
        return content;
    }

    private cleanDescription(description: string): string {
        return description.replace(/<[^>]*>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n\s*\n/g, '\n\n').trim();
    }

    generateFileName(data: ComicIssueData): string {
        const sanitize = (str: string) => str.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
        const volumeName = sanitize(data.volume.name);
        const issueNumber = sanitize(data.issue.issue_number).padStart(3, '0');
        return `${volumeName} #${issueNumber}.md`;
    }
}

// ========================
// SEARCH MODAL
// ========================
class ComicSearchModal extends FuzzySuggestModal<ComicVineIssue> {
    private plugin: ComicSearchPlugin;
    private client: ComicVineClient;
    private searchResults: ComicVineIssue[] = [];
    private isSearching = false;
    private searchTimeout: NodeJS.Timeout | null = null;
    private currentSearchQuery = '';
    private abortController: AbortController | null = null;

    constructor(app: App, plugin: ComicSearchPlugin) {
        super(app);
        this.plugin = plugin;
        this.client = new ComicVineClient(plugin.settings.comicVineApiKey, plugin.settings.rateLimitDelay);
        this.setPlaceholder("Search for comic issues (e.g., 'Uncanny X-Men 141')");
        this.setInstructions([{ command: "↑↓", purpose: "navigate" }, { command: "↵", purpose: "select issue" }, { command: "esc", purpose: "dismiss" }]);
    }

    getItems(): ComicVineIssue[] { return this.searchResults; }
    getItemText(issue: ComicVineIssue): string { return `${issue.volume.name} #${issue.issue_number}${issue.name ? ` - ${issue.name}` : ''}`; }
    getSuggestions(query: string): FuzzyMatch<ComicVineIssue>[] { return this.searchResults.map(issue => ({ item: issue, match: { score: 1, matches: [] } })); }

    renderSuggestion(match: FuzzyMatch<ComicVineIssue>, el: HTMLElement) {
        const issue = match.item;
        const container = el.createDiv({ cls: 'comic-search-suggestion' });
        if (issue.image?.small_url) {
            const imageContainer = container.createDiv({ cls: 'comic-search-image' });
            const img = imageContainer.createEl('img', { cls: 'comic-cover-thumb', attr: { src: issue.image.small_url, alt: 'Cover' } });
            img.onerror = () => { imageContainer.style.display = 'none'; };
        }
        const textContainer = container.createDiv({ cls: 'comic-search-text' });
        textContainer.createDiv({ cls: 'comic-search-title' }).setText(`${issue.volume.name} #${issue.issue_number}`);
        if (issue.name && issue.name !== issue.volume.name) textContainer.createDiv({ cls: 'comic-search-subtitle', text: issue.name });
        textContainer.createDiv({ cls: 'comic-search-meta', text: `${issue.cover_date || 'Unknown date'}` });
        if (issue.deck) textContainer.createDiv({ cls: 'comic-search-desc', text: issue.deck.substring(0, 120) + (issue.deck.length > 120 ? '...' : '') });
    }

    async onChooseItem(issue: ComicVineIssue) {
        try {
            this.cancelPendingSearch();
            new Notice('Fetching comic details...');
            await this.plugin.createIssueNote(issue);
        } catch (error) {
            new Notice(`Failed to create comic note: ${error.message}`);
            console.error('Failed to create comic note:', error);
        }
    }

    private cancelPendingSearch() {
        if (this.searchTimeout) { clearTimeout(this.searchTimeout); this.searchTimeout = null; }
        if (this.abortController) { this.abortController.abort(); this.abortController = null; }
        this.isSearching = false;
    }

    private async performSearch(query: string): Promise<void> {
        this.abortController = new AbortController();
        const currentController = this.abortController;
        try {
            this.isSearching = true;
            this.currentSearchQuery = query;
            this.searchResults = [];
            (this as any).updateSuggestions();
            const results = await this.client.searchIssues(query, currentController.signal);
            if (currentController.signal.aborted) return;
            if (this.currentSearchQuery === query) {
                this.searchResults = results;
                (this as any).updateSuggestions();
            }
        } catch (error) {
            if (currentController.signal.aborted) return;
            new Notice(`Search failed: ${error.message}`);
            this.searchResults = [];
            (this as any).updateSuggestions();
        } finally {
            if (currentController === this.abortController) {
                this.isSearching = false;
                this.abortController = null;
            }
        }
    }

    onInput() {
        const query = this.inputEl.value || '';
        this.cancelPendingSearch();
        if (query.length < 3) {
            this.searchResults = [];
            this.currentSearchQuery = '';
            (this as any).updateSuggestions();
            return;
        }
        this.searchTimeout = setTimeout(() => {
            this.searchTimeout = null;
            if (!this.isSearching) this.performSearch(query);
        }, 500);
    }

    onOpen() {
        super.onOpen();
        const styleId = 'comic-search-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .comic-search-suggestion { display: flex; padding: 8px 0; align-items: flex-start; gap: 8px; }
                .comic-search-image { flex-shrink: 0; width: 40px; }
                .comic-cover-thumb { width: 40px; height: auto; border-radius: 2px; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
                .comic-search-text { flex: 1; min-width: 0; }
                .comic-search-title { font-weight: bold; } .comic-search-subtitle { font-style: italic; color: var(--text-muted); }
                .comic-search-meta { font-size: 0.85em; color: var(--text-muted); } .comic-search-desc { font-size: 0.8em; color: var(--text-faint); }
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
        this.addRibbonIcon('book', 'Search Comics', () => {
            if (!this.settings.comicVineApiKey) {
                new Notice('Please configure your ComicVine API key in settings first');
                return;
            }
            new ComicSearchModal(this.app, this).open();
        });
        this.addCommand({
            id: 'search-comics',
            name: 'Search for comic issues',
            callback: () => {
                if (!this.settings.comicVineApiKey) {
                    new Notice('Please configure your ComicVine API key in settings first');
                    return;
                }
                new ComicSearchModal(this.app, this).open();
            }
        });
        this.addSettingTab(new ComicSearchSettingTab(this.app, this));
        console.log('Comic Search Plugin loaded');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async createIssueNote(issue: ComicVineIssue): Promise<void> {
        try {
            const client = new ComicVineClient(this.settings.comicVineApiKey, this.settings.rateLimitDelay);
            
            new Notice('Fetching detailed issue information...');
            const detailedIssue = await client.getIssueDetails(issue.id);
            
            new Notice('Fetching volume information...');
            const volume = await client.getVolumeDetails(issue.volume.id);
            
            if (this.settings.createCreatorNotes) {
                this.ensureCreatorNotesExist(detailedIssue.person_credits);
            }
            
            const data = this.processIssueData(detailedIssue, volume);
            const generator = new ComicNoteGenerator(this.settings);
            const noteContent = generator.generateIssueNote(data);
            const fileName = generator.generateFileName(data);
            
            await this.ensureComicsFolder();
            
            const filePath = `${this.settings.comicsFolder}/${fileName}`;
            const existingFile = this.app.vault.getAbstractFileByPath(filePath);

            if (existingFile) {
                new Notice(`Note for ${data.volume.name} #${data.issue.issue_number} already exists. To overwrite, delete it first.`);
                return;
            }
            
            const file = await this.app.vault.create(filePath, noteContent);
            const leaf = this.app.workspace.getMostRecentLeaf();
            if (leaf) await leaf.openFile(file);
            new Notice(`Created note: ${fileName}`);
            
        } catch (error) {
            console.error('Error creating issue note:', error);
            new Notice(`Error creating note: ${error.message}`);
        }
    }
    
    private async ensureCreatorNotesExist(creators: ComicVineIssue['person_credits']): Promise<void> {
        if (!this.settings.createCreatorNotes || !creators || creators.length === 0) return;

        const client = new ComicVineClient(this.settings.comicVineApiKey, this.settings.rateLimitDelay);
        const generator = new ComicNoteGenerator(this.settings);
        const creatorsFolder = `${this.settings.comicsFolder}/Creators`;
        
        if (!this.app.vault.getAbstractFileByPath(creatorsFolder)) {
            await this.app.vault.createFolder(creatorsFolder);
        }

        const uniqueCreators = new Map<number, typeof creators[0]>();
        creators.forEach(c => uniqueCreators.set(c.id, c));

        for (const creator of uniqueCreators.values()) {
            const fileName = creator.name.replace(/[<>:"/\\|?*]/g, '').trim() + '.md';
            const filePath = `${creatorsFolder}/${fileName}`;
            if (this.app.vault.getAbstractFileByPath(filePath)) continue;

            try {
                new Notice(`Fetching details for creator: ${creator.name}...`, 2000);
                const personDetails = await client.getPersonDetails(creator.api_detail_url);
                const noteContent = generator.generateCreatorNote(personDetails);
                await this.app.vault.create(filePath, noteContent);
                new Notice(`Created note for creator: ${creator.name}`, 3000);
            } catch (error) {
                new Notice(`Failed to create note for ${creator.name}: ${error.message}`, 5000);
                console.error(`Failed to process creator ${creator.name} (ID: ${creator.id}):`, error);
            }
        }
    }

    private processIssueData(issue: ComicVineIssue, volume: ComicVineVolume): ComicIssueData {
        const creators: Record<string, string[]> = {};
        
        if (issue.person_credits) {
            issue.person_credits.forEach(credit => {
                const roles = credit.role.split(',').map(r => r.trim());
                roles.forEach(singleRole => {
                    if (!singleRole) return;

                    const role = singleRole.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                    if (!creators[role]) creators[role] = [];
                    if (!creators[role].includes(credit.name)) creators[role].push(credit.name);
                });
            });
        }
        
        const characters = issue.character_credits ? [...new Set(issue.character_credits.map(char => char.name))] : [];
        const storyArcs = issue.story_arc_credits ? [...new Set(issue.story_arc_credits.map(arc => arc.name))] : [];
        
        return {
            issue,
            volume,
            publisher: volume.publisher?.name || 'Unknown Publisher',
            creators,
            characters,
            storyArcs,
            coverUrl: issue.image?.super_url,
            deck: issue.deck,
            comicVineUrl: issue.site_detail_url
        };
    }

    private async ensureComicsFolder(): Promise<void> {
        const folderPath = this.settings.comicsFolder;
        if (!this.app.vault.getAbstractFileByPath(folderPath)) {
            await this.app.vault.createFolder(folderPath);
            new Notice(`Created comics folder: ${folderPath}`);
        }
    }
}

// ========================
// SETTINGS TAB
// ========================
class ComicSearchSettingTab extends PluginSettingTab {
    plugin: ComicSearchPlugin;

    constructor(app: App, plugin: ComicSearchPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Comic Search Settings' });

        new Setting(containerEl)
            .setName('ComicVine API Key')
            .setDesc(createFragment(frag => {
                frag.appendText('Get your free API key from ');
                frag.createEl('a', { text: 'ComicVine', href: 'https://comicvine.gamespot.com/api/' });
            }))
            .addText(text => text.setPlaceholder('Enter your API key').setValue(this.plugin.settings.comicVineApiKey).onChange(async (value) => {
                this.plugin.settings.comicVineApiKey = value;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('Comics Folder')
            .setDesc('Folder where comic notes will be created')
            .addText(text => text.setPlaceholder('Comics').setValue(this.plugin.settings.comicsFolder).onChange(async (value) => {
                this.plugin.settings.comicsFolder = value || 'Comics';
                await this.plugin.saveSettings();
            }));
        
        new Setting(containerEl)
            .setName('Create Creator Notes')
            .setDesc('Automatically create notes for comic creators (writers, artists, etc.) if they do not exist in the "Creators" subfolder.')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.createCreatorNotes).onChange(async (value) => {
                this.plugin.settings.createCreatorNotes = value;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('Default Page Count')
            .setDesc('Default number of pages for comic issues (for reading tracker)')
            .addText(text => text.setPlaceholder('22').setValue(String(this.plugin.settings.defaultPageCount)).onChange(async (value) => {
                const num = parseInt(value);
                if (!isNaN(num) && num > 0) this.plugin.settings.defaultPageCount = num;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('Reading Tracker Integration')
            .setDesc('Include reading tracker compatible YAML frontmatter')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.enableReadingTracker).onChange(async (value) => {
                this.plugin.settings.enableReadingTracker = value;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('Rate Limit Delay (ms)')
            .setDesc('Delay between API requests to respect ComicVine rate limits (min 500)')
            .addText(text => text.setPlaceholder('1000').setValue(String(this.plugin.settings.rateLimitDelay)).onChange(async (value) => {
                const num = parseInt(value);
                if (!isNaN(num) && num >= 500) this.plugin.settings.rateLimitDelay = num;
                await this.plugin.saveSettings();
            }));

        containerEl.createEl('h3', { text: 'How to Use' });
        containerEl.createEl('div').innerHTML = `
            <ol>
                <li>Get a free ComicVine API key and enter it above.</li>
                <li>Use the ribbon icon or command palette to search for comics.</li>
                <li>Select an issue to create a note for it.</li>
                <li>If 'Create Creator Notes' is enabled, notes for the writers and artists will be created automatically in a subfolder.</li>
            </ol>
            <p><strong>Note:</strong> This plugin respects ComicVine's rate limits. Search results and creator downloads may take a moment.</p>
        `;
    }
}
