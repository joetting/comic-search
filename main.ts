// main.ts - Comic Search Plugin Phase 1 - Fixed YAML Generation
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
}

const DEFAULT_SETTINGS: ComicSearchSettings = {
    comicVineApiKey: '',
    comicsFolder: 'Comics',
    defaultPageCount: 22,
    enableReadingTracker: true,
    rateLimitDelay: 1000 // 1 second between requests
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

interface ComicIssueData {
    issue: ComicVineIssue;
    volume: ComicVineVolume;
    publisher: string;
    writers: string[];
    artists: string[];
    characters: string[];
    storyArcs: string[];
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
                
                // Handle abort during delay
                if (abortSignal) {
                    abortSignal.addEventListener('abort', () => {
                        clearTimeout(timeout);
                        reject(new Error('Request aborted'));
                    });
                }
            });
        }

        // Check if aborted before making request
        if (abortSignal?.aborted) {
            throw new Error('Request aborted');
        }

        this.lastRequestTime = Date.now();
        
        try {
            console.log('Requesting URL:', url);

            const response = await requestUrl({
                url: url,
                headers: { 'User-Agent': 'ObsidianComicSearch/1.0' }
            });

            console.log('Received API Response:', response.json);
            return response.json;

        } catch (error) {
            console.error("ComicVine API request failed:", error);
            if (error.status) {
                throw new Error(`API request failed: Status ${error.status}`);
            }
            throw new Error(`API request failed: ${error.message}`);
        }
    }

    async searchIssues(query: string, abortSignal?: AbortSignal): Promise<ComicVineIssue[]> {
        if (!this.apiKey) {
            throw new Error('ComicVine API key not configured');
        }

        const encodedQuery = encodeURIComponent(query);
        const url = `${this.baseUrl}/search/?api_key=${this.apiKey}&format=json&resources=issue&query=${encodedQuery}&field_list=id,name,issue_number,cover_date,volume,image,deck&limit=10`;

        try {
            const response: ComicVineResponse<ComicVineIssue[]> = await this.rateLimitedFetch(url, abortSignal);
            
            if (response.error !== 'OK') {
                throw new Error(`ComicVine API error: ${response.error}`);
            }

            return response.results || [];
        } catch (error) {
            if (error.message === 'Request aborted') {
                throw error; // Re-throw abort errors
            }
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
}

// ========================
// NOTE GENERATOR - FIXED YAML GENERATION
// ========================
class ComicNoteGenerator {
    private settings: ComicSearchSettings;

    constructor(settings: ComicSearchSettings) {
        this.settings = settings;
    }

    generateIssueNote(data: ComicIssueData): string {
        const { issue, volume, publisher, writers, artists, characters, storyArcs } = data;
        
        // Create YAML frontmatter
        const yaml = this.generateYAML(data);
        
        // Create markdown content
        const content = this.generateContent(data);
        
        return `---\n${yaml}\n---\n\n${content}`;
    }

    private generateYAML(data: ComicIssueData): string {
        const { issue, volume, publisher, writers, artists, characters, storyArcs } = data;
        
        let yaml = '';
        
        // Reading Tracker compatibility
        if (this.settings.enableReadingTracker) {
            yaml += `entityType: ComicIssue\n`;
            yaml += `title: ${this.quoteYamlString(`${volume.name} #${issue.issue_number}`)}\n`;
            yaml += `author: ${this.quoteYamlString(writers[0] || 'Unknown')}\n`;
            yaml += `pages: ${this.settings.defaultPageCount}\n`;
            yaml += `currentPage: 0\n`;
            yaml += `percentComplete: 0\n`;
            yaml += `lastRead:\n`;
            yaml += `type: comic\n\n`;
        }
        
        // Comic metadata
        yaml += `# Comic Metadata\n`;
        yaml += `volume: ${this.formatWikilink(volume.name)}\n`;
        yaml += `issueNumber: ${this.quoteYamlString(issue.issue_number)}\n`;
        yaml += `publisher: ${this.formatWikilink(publisher)}\n`;
        yaml += `coverDate: ${this.quoteYamlString(issue.cover_date)}\n`;
        
        if (issue.store_date) {
            yaml += `storeDate: ${this.quoteYamlString(issue.store_date)}\n`;
        }
        
        yaml += `comicVineId: ${this.quoteYamlString(String(issue.id))}\n\n`;
        
        // Creators
        if (writers.length > 0) {
            yaml += `# Creators\n`;
            writers.forEach(writer => {
                yaml += `writer: ${this.formatWikilink(writer)}\n`;
            });
        }
        
        if (artists.length > 0) {
            artists.forEach(artist => {
                yaml += `artist: ${this.formatWikilink(artist)}\n`;
            });
        }
        
        if (writers.length > 0 || artists.length > 0) {
            yaml += '\n';
        }
        
        // Characters
        if (characters.length > 0) {
            yaml += `# Characters\n`;
            yaml += `features:\n`;
            characters.forEach(character => {
                yaml += `  - ${this.formatWikilink(character)}\n`;
            });
            yaml += '\n';
        }
        
        // Story Arcs
        if (storyArcs.length > 0) {
            yaml += `# Story Arcs\n`;
            yaml += `partOfStoryArc:\n`;
            storyArcs.forEach(arc => {
                yaml += `  - ${this.formatWikilink(arc)}\n`;
            });
            yaml += '\n';
        }
        
        // Tags
        yaml += `tags:\n`;
        yaml += `  - comic\n`;
        yaml += `  - ${this.sanitizeForTag(publisher)}\n`;
        yaml += `  - ${this.sanitizeForTag(volume.name)}\n`;
        
        return yaml;
    }

    /**
     * Properly formats a wikilink for YAML by cleaning the text and quoting the entire wikilink
     */
    private formatWikilink(text: string): string {
        if (!text) return '""';
        
        // Clean the text for use in wikilinks
        const cleanText = this.cleanForWikilink(text);
        
        // Create the wikilink and quote it for YAML safety
        const wikilink = `[[${cleanText}]]`;
        return this.quoteYamlString(wikilink);
    }

    /**
     * Cleans text for use inside wikilinks by removing/replacing problematic characters
     */
    private cleanForWikilink(text: string): string {
        return text
            // Remove HTML tags
            .replace(/<[^>]*>/g, '')
            // Remove leading/trailing quotes
            .replace(/^["']|["']$/g, '')
            // Replace problematic characters that break wikilinks
            .replace(/\|/g, ' - ')  // Pipe characters break wikilinks
            .replace(/\[\[|\]\]/g, '') // Remove nested wikilink brackets
            // Clean up whitespace
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Properly quotes strings for YAML, handling special characters and multiline strings
     */
    private quoteYamlString(value: string): string {
        if (!value) return '""';
        
        // Check if the string needs quoting
        const needsQuoting = /[:\[\]{}|>@`"'\\#&*!?\-%]|^\s|\s$|^-|^[0-9]/.test(value) || 
                           value.includes('\n') || 
                           value.includes('\r') ||
                           value.toLowerCase() === 'true' || 
                           value.toLowerCase() === 'false' ||
                           value.toLowerCase() === 'null' ||
                           value.toLowerCase() === 'yes' ||
                           value.toLowerCase() === 'no';
        
        if (!needsQuoting) {
            return value;
        }
        
        // For multiline strings, use literal block scalar
        if (value.includes('\n')) {
            return '|\n  ' + value.split('\n').join('\n  ');
        }
        
        // For single line strings, use double quotes and escape as needed
        return '"' + value
            .replace(/\\/g, '\\\\')  // Escape backslashes
            .replace(/"/g, '\\"')    // Escape quotes
            .replace(/\n/g, '\\n')   // Escape newlines
            .replace(/\r/g, '\\r') + '"';  // Escape carriage returns
    }

    /**
     * Sanitizes text for use as YAML tags
     */
    private sanitizeForTag(text: string): string {
        return text
            .replace(/[^a-zA-Z0-9\s-]/g, '')  // Remove special characters
            .replace(/\s+/g, '-')             // Replace spaces with hyphens
            .toLowerCase()
            .replace(/^-+|-+$/g, '')          // Remove leading/trailing hyphens
            .replace(/-+/g, '-')              // Collapse multiple hyphens
            || 'unknown';                      // Fallback if empty
    }

    private generateContent(data: ComicIssueData): string {
        const { issue, volume, publisher, writers, artists, characters, storyArcs } = data;
        
        let content = '';
        
        // Cover image
        if (issue.image?.super_url) {
            content += `![cover|150](${issue.image.super_url})\n\n`;
        }
        
        // Title
        content += `## ${volume.name} #${issue.issue_number}\n`;
        if (issue.name && issue.name !== volume.name) {
            content += `*${issue.name}*\n\n`;
        } else {
            content += '\n';
        }
        
        // Publication info
        content += `**Published:** ${issue.cover_date}`;
        if (publisher) {
            content += ` (${publisher})`;
        }
        content += '\n\n';
        
        // Creative team
        if (writers.length > 0 || artists.length > 0) {
            content += `### Creative Team\n`;
            writers.forEach(writer => {
                content += `- **Writer:** [[${this.cleanForWikilink(writer)}]]\n`;
            });
            artists.forEach(artist => {
                content += `- **Artist:** [[${this.cleanForWikilink(artist)}]]\n`;
            });
            content += '\n';
        }
        
        // Characters
        if (characters.length > 0) {
            content += `### Characters\n`;
            characters.forEach(character => {
                content += `- [[${this.cleanForWikilink(character)}]]\n`;
            });
            content += '\n';
        }
        
        // Story arcs
        if (storyArcs.length > 0) {
            content += `### Story Arc\n`;
            storyArcs.forEach(arc => {
                content += `Part of: [[${this.cleanForWikilink(arc)}]]\n`;
            });
            content += '\n';
        }
        
        // Description
        if (issue.description) {
            content += `### Description\n`;
            content += `${this.cleanDescription(issue.description)}\n\n`;
        } else if (issue.deck) {
            content += `### Description\n`;
            content += `${issue.deck}\n\n`;
        }
        
        // Reading notes section
        content += `### Reading Notes\n`;
        content += `*Add your thoughts here...*\n\n`;
        
        // Key events section
        content += `### Key Events\n`;
        content += `- \n\n`;
        
        // References
        content += `### References\n`;
        content += `- [ComicVine](${issue.site_detail_url})\n`;
        
        return content;
    }

    private cleanDescription(description: string): string {
        return description
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();
    }

    generateFileName(data: ComicIssueData): string {
        const { issue, volume } = data;
        
        const sanitize = (str: string) => str
            .replace(/[<>:"/\\|?*]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        
        const volumeName = sanitize(volume.name);
        const issueNumber = sanitize(issue.issue_number);
        
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
        this.client = new ComicVineClient(
            plugin.settings.comicVineApiKey,
            plugin.settings.rateLimitDelay
        );
        this.setPlaceholder("Search for comic issues (e.g., 'Uncanny X-Men 141')");
        this.setInstructions([
            { command: "↑↓", purpose: "navigate" },
            { command: "↵", purpose: "select issue" },
            { command: "esc", purpose: "dismiss" }
        ]);
    }

    getItems(): ComicVineIssue[] {
        return this.searchResults;
    }

    getItemText(issue: ComicVineIssue): string {
        return `${issue.volume.name} #${issue.issue_number}${issue.name ? ` - ${issue.name}` : ''}`;
    }
    
    getSuggestions(query: string): FuzzyMatch<ComicVineIssue>[] {
        // Return all results without additional filtering since we're doing our own search
        return this.searchResults.map(issue => ({
            item: issue,
            match: { score: 1, matches: [] }
        }));
    }

    renderSuggestion(match: FuzzyMatch<ComicVineIssue>, el: HTMLElement) {
        const issue = match.item;
        const container = el.createDiv({ cls: 'comic-search-suggestion' });
        
        // Add cover image if available
        if (issue.image?.small_url) {
            const imageContainer = container.createDiv({ cls: 'comic-search-image' });
            const img = imageContainer.createEl('img', { 
                cls: 'comic-cover-thumb',
                attr: { src: issue.image.small_url, alt: 'Cover' }
            });
            img.onerror = () => { imageContainer.style.display = 'none'; };
        }
        
        const textContainer = container.createDiv({ cls: 'comic-search-text' });
        
        const title = textContainer.createDiv({ cls: 'comic-search-title' });
        title.setText(`${issue.volume.name} #${issue.issue_number}`);
        
        if (issue.name && issue.name !== issue.volume.name) {
            const subtitle = textContainer.createDiv({ cls: 'comic-search-subtitle' });
            subtitle.setText(issue.name);
        }
        
        const meta = textContainer.createDiv({ cls: 'comic-search-meta' });
        meta.setText(`${issue.cover_date || 'Unknown date'}`);
        
        if (issue.deck) {
            const desc = textContainer.createDiv({ cls: 'comic-search-desc' });
            desc.setText(issue.deck.substring(0, 120) + (issue.deck.length > 120 ? '...' : ''));
        }
    }

    async onChooseItem(issue: ComicVineIssue) {
        try {
            // Cancel any pending searches
            this.cancelPendingSearch();
            
            new Notice('Fetching comic details...');
            await this.plugin.createIssueNote(issue);
        } catch (error) {
            new Notice(`Failed to create comic note: ${error.message}`);
            console.error('Failed to create comic note:', error);
        }
    }

    private cancelPendingSearch() {
        // Clear debounce timeout
        if (this.searchTimeout) {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = null;
        }
        
        // Abort any ongoing request
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        
        this.isSearching = false;
    }

    private async performSearch(query: string): Promise<void> {
        // Create new abort controller for this search
        this.abortController = new AbortController();
        const currentController = this.abortController;
        
        try {
            this.isSearching = true;
            this.currentSearchQuery = query;
            
            console.log(`Performing search for: "${query}"`);
            
            // Show loading state
            this.searchResults = [];
            (this as any).updateSuggestions();
            
            const results = await this.client.searchIssues(query, currentController.signal);
            
            // Check if this search was cancelled
            if (currentController.signal.aborted) {
                console.log('Search was cancelled');
                return;
            }
            
            // Only update if this is still the current search query
            if (this.currentSearchQuery === query) {
                this.searchResults = results;
                console.log(`Search completed for "${query}":`, results.length, 'results');
                (this as any).updateSuggestions();
            }
            
        } catch (error) {
            if (currentController.signal.aborted) {
                console.log('Search request was aborted');
                return;
            }
            
            console.error('Search failed:', error);
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

    async onInput() {
        // Get the actual query text from the input element
        const inputEl = this.inputEl as HTMLInputElement;
        const query = inputEl.value || '';
        
        console.log(`Input changed: "${query}"`);
        
        // Cancel any pending search
        this.cancelPendingSearch();
        
        // Clear results for short queries
        if (query.length < 3) {
            this.searchResults = [];
            this.currentSearchQuery = '';
            (this as any).updateSuggestions();
            return;
        }
        
        // Debounce the search - wait for user to stop typing
        this.searchTimeout = setTimeout(() => {
            this.searchTimeout = null;
            if (!this.isSearching) {
                this.performSearch(query);
            }
        }, 500); // Wait 500ms after user stops typing
    }

    onOpen() {
        super.onOpen();
        
        const style = document.createElement('style');
        style.id = 'comic-search-styles'; 
        if (!document.getElementById(style.id)) {
            style.textContent = `
                .comic-search-suggestion { 
                    display: flex; 
                    padding: 8px 0; 
                    align-items: flex-start;
                    gap: 8px;
                }
                .comic-search-image {
                    flex-shrink: 0;
                    width: 40px;
                }
                .comic-cover-thumb {
                    width: 40px;
                    height: auto;
                    border-radius: 2px;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                }
                .comic-search-text {
                    flex: 1;
                    min-width: 0;
                }
                .comic-search-title { 
                    font-weight: bold; 
                    margin-bottom: 2px; 
                    word-wrap: break-word;
                }
                .comic-search-subtitle { 
                    font-style: italic; 
                    color: var(--text-muted); 
                    margin-bottom: 2px; 
                    word-wrap: break-word;
                }
                .comic-search-meta { 
                    font-size: 0.85em; 
                    color: var(--text-muted); 
                    margin-bottom: 4px; 
                }
                .comic-search-desc { 
                    font-size: 0.8em; 
                    color: var(--text-faint); 
                    line-height: 1.2; 
                    word-wrap: break-word;
                }
            `;
            document.head.appendChild(style);
        }
    }

    onClose() {
        super.onClose();
        
        // Clean up when modal closes
        this.cancelPendingSearch();
        
        const style = document.getElementById('comic-search-styles');
        if (style) {
            style.remove();
        }
    }
}

// ========================
// MAIN PLUGIN CLASS
// ========================

export default class ComicSearchPlugin extends Plugin {
    settings: ComicSearchSettings;

    async onload() {
        await this.loadSettings();

        // Add ribbon icon
        this.addRibbonIcon('book', 'Search Comics', () => {
            if (!this.settings.comicVineApiKey) {
                new Notice('Please configure your ComicVine API key in settings first');
                return;
            }
            new ComicSearchModal(this.app, this).open();
        });

        // Add command
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

        // Add settings tab
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
            const client = new ComicVineClient(
                this.settings.comicVineApiKey,
                this.settings.rateLimitDelay
            );
            
            new Notice('Fetching detailed issue information...');
            const detailedIssue = await client.getIssueDetails(issue.id);
            
            new Notice('Fetching volume information...');
            const volume = await client.getVolumeDetails(issue.volume.id);
            
            const data = this.processIssueData(detailedIssue, volume);
            const generator = new ComicNoteGenerator(this.settings);
            const noteContent = generator.generateIssueNote(data);
            const fileName = generator.generateFileName(data);
            
            await this.ensureComicsFolder();
            
            const filePath = `${this.settings.comicsFolder}/${fileName}`;
            const existingFile = this.app.vault.getAbstractFileByPath(filePath);

            if (existingFile) {
                if (!confirm(`A note for ${data.volume.name} #${data.issue.issue_number} already exists. Overwrite?`)) {
                    return;
                }
                if (existingFile instanceof TFile) {
                    await this.app.vault.delete(existingFile);
                }
            }
            
            const file = await this.app.vault.create(filePath, noteContent);
            const leaf = this.app.workspace.getMostRecentLeaf();
            if (leaf) {
                await leaf.openFile(file);
            }
            
            new Notice(`Created note: ${fileName}`);
            
        } catch (error) {
            console.error('Error creating issue note:', error);
            throw error;
        }
    }

    private processIssueData(issue: ComicVineIssue, volume: ComicVineVolume): ComicIssueData {
        const writers: string[] = [];
        const artists: string[] = [];
        
        if (issue.person_credits) {
            issue.person_credits.forEach(credit => {
                const role = credit.role.toLowerCase();
                if (role.includes('writer') || role.includes('script')) writers.push(credit.name);
                else if (role.includes('pencil') || role.includes('artist') || role.includes('draw')) artists.push(credit.name);
            });
        }
        
        const characters = issue.character_credits ? issue.character_credits.map(char => char.name) : [];
        const storyArcs = issue.story_arc_credits ? issue.story_arc_credits.map(arc => arc.name) : [];
        
        return {
            issue,
            volume,
            publisher: volume.publisher?.name || 'Unknown Publisher',
            writers: [...new Set(writers)],
            artists: [...new Set(artists)],
            characters: [...new Set(characters)],
            storyArcs: [...new Set(storyArcs)]
        };
    }

    private async ensureComicsFolder(): Promise<void> {
        const { vault } = this.app;
        const folderPath = this.settings.comicsFolder;
        if (!vault.getAbstractFileByPath(folderPath)) {
            await vault.createFolder(folderPath);
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
            .addText(text => text
                .setPlaceholder('Enter your API key')
                .setValue(this.plugin.settings.comicVineApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.comicVineApiKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Comics Folder')
            .setDesc('Folder where comic notes will be created')
            .addText(text => text
                .setPlaceholder('Comics')
                .setValue(this.plugin.settings.comicsFolder)
                .onChange(async (value) => {
                    this.plugin.settings.comicsFolder = value || 'Comics';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Default Page Count')
            .setDesc('Default number of pages for comic issues (typically 22)')
            .addText(text => text
                .setPlaceholder('22')
                .setValue(String(this.plugin.settings.defaultPageCount))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.defaultPageCount = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Reading Tracker Integration')
            .setDesc('Include reading tracker compatible YAML frontmatter')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableReadingTracker)
                .onChange(async (value) => {
                    this.plugin.settings.enableReadingTracker = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Rate Limit Delay (ms)')
            .setDesc('Delay between API requests to respect ComicVine rate limits (min 500)')
            .addText(text => text
                .setPlaceholder('1000')
                .setValue(String(this.plugin.settings.rateLimitDelay))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num >= 500) {
                        this.plugin.settings.rateLimitDelay = num;
                        await this.plugin.saveSettings();
                    }
                }));

        containerEl.createEl('h3', { text: 'How to Use' });
        const instructions = containerEl.createEl('div');
        instructions.innerHTML = `
            <ol>
                <li>Get your free ComicVine API key from <a href="https://comicvine.gamespot.com/api/" target="_blank">ComicVine</a></li>
                <li>Enter your API key in the settings above</li>
                <li>Use the ribbon icon or command palette to search for comics</li>
                <li>Search by typing: "Uncanny X-Men 141", "Batman Detective Comics", etc.</li>
                <li>Select an issue from the results to create a note</li>
            </ol>
            <p><strong>Note:</strong> This plugin respects ComicVine's rate limits (200 requests per hour). 
            Search results may take a moment to appear.</p>
        `;
    }
}