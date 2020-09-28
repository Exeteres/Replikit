import {
    ModuleManager,
    ConfigManager,
    logger,
    getConfigPath,
    PMController,
    PMType,
    createPMController,
    getPMController,
    GitController
} from "@replikit/cli";
import { resolve, basename, join } from "path";
import { writeFile, mkdir, writeJSON, pathExists, readJSON, readdir, ensureDir } from "fs-extra";
import { PackageConfig } from "@replikit/cli/typings";

export class ProjectManager {
    readonly name: string;
    readonly externalPath: string;
    readonly git: GitController;

    private readonly configManager: ConfigManager;
    private pm: PMController;
    private configPath: string;

    constructor(readonly root: string, configManager?: ConfigManager) {
        this.configManager = configManager ?? new ConfigManager();
        this.name = basename(this.root);
        this.externalPath = join(this.root, "external");
        this.git = new GitController(this.externalPath);
    }

    private async saveConfig(): Promise<void> {
        await writeFile(this.configPath, this.configManager.serialize());
    }

    getConfigManager(): ConfigManager {
        return this.configManager;
    }

    /**
     * Sets the package manager type to use.
     */
    setPackageManager(type: PMType): void {
        this.pm = createPMController(type, this.root);
    }

    /**
     * Initializes a new project in the root directory.
     * Creates initial file structure and `package.json`.
     */
    async init(): Promise<void> {
        this.configManager.init();

        const exists = await pathExists(this.root);
        if (!exists) {
            await ensureDir(this.root);
        }

        // Create modules folder
        const modulesPath = resolve(this.root, "modules");
        await mkdir(modulesPath);

        // Create tsconfig
        const tsconfigPath = resolve(this.root, "tsconfig.json");
        const tsconfig = {
            compilerOptions: {
                target: "es2019",
                module: "commonjs",
                moduleResolution: "node",
                baseUrl: "modules",
                strict: true,
                paths: {
                    [`@${this.name}/*`]: ["*/src"],
                    [`@${this.name}/*/typings`]: ["*/typings"]
                }
            },
            include: ["replikit.config.ts", "modules/**/*.ts"]
        };
        await writeJSON(tsconfigPath, tsconfig, { spaces: 4 });

        // Init package
        this.pm.init(this.name, true);
        await this.pm.save();

        // Create replikit configuration
        this.configPath = resolve(this.root, "replikit.config.ts");
        await this.saveConfig();
    }

    /**
     * Adds lerna dependency and configuration to the project.
     */
    async addLerna(): Promise<void> {
        await this.pm.install(["lerna"], true);
        const lernaConfigPath = resolve(this.root, "lerna.json");
        const isYarn = this.pm.type === PMType.Yarn;
        const props = isYarn ? { npmClient: "yarn", useWorkspaces: true } : { npmClient: "npm" };
        const lernaConfig = {
            version: "0.0.0",
            ...props
        };
        await writeJSON(lernaConfigPath, lernaConfig, { spaces: 4 });
    }

    /**
     * Updates tsconfig paths to use modules from external repo.
     */
    async addExternalRepo(path: string): Promise<void> {
        const packageJsonPath = join(this.externalPath, path, "package.json");
        const packageJson: PackageConfig = await readJSON(packageJsonPath);
        const tsconfigPath = resolve(this.root, "tsconfig.json");
        const tsconfig = await readJSON(tsconfigPath);
        tsconfig.compilerOptions.paths = {
            ...tsconfig.compilerOptions.paths,
            [`@${packageJson.name}/*`]: [`../external/${path}/modules/*/src`],
            [`@${packageJson.name}/*/typings`]: [`../external/${path}/modules/*/typings`]
        };
        await writeJSON(tsconfigPath, tsconfig, { spaces: 4 });
    }

    /**
     * Gets names of all modules in the external repo.
     */
    async getExternalModuleNames(path: string): Promise<string[]> {
        const repoPath = join(this.externalPath, path);
        const packageJsonPath = join(repoPath, "package.json");
        const packageJson: PackageConfig = await readJSON(packageJsonPath);
        const modulesPath = join(repoPath, "modules");
        const moduleNames = await readdir(modulesPath);
        return moduleNames.map(x => `@${packageJson.name}/${x}`);
    }

    /**
     * Loads an existing project from the root directory.
     */
    async load(): Promise<void> {
        this.configPath = getConfigPath();
        logger.debug("Loading project " + this.root);

        this.pm = await getPMController(this.root);
        await this.pm.load();
    }

    /**
     * Creates a new module and adds it to the configuration.
     */
    async createModule(name: string): Promise<ModuleManager> {
        const module = this.getModule(name);
        await module.init();
        if (!this.configManager.checkModule(module.fullName)) {
            this.configManager.addModule(module.fullName);
            await this.saveConfig();
        }
        return module;
    }

    /**
     * Installs dependencies to the project.
     */
    async install(modules: string[], dev?: boolean): Promise<void> {
        await this.pm.install(modules, dev);
    }

    /**
     * Adds already installed modules to the project and updates config.
     */
    async addLocalModules(modules: string[]): Promise<void> {
        for (const module of modules) {
            this.configManager.addModule(module);
        }
        await this.saveConfig();
    }

    /**
     * Adds modules to the project and updates config.
     */
    async addModules(modules: string[], dev?: boolean): Promise<void> {
        await this.install(modules, dev);
        await this.addLocalModules(modules);
    }

    /**
     * Returns a `ModuleManager` for the module with specified name.
     */
    getModule(name: string): ModuleManager {
        return new ModuleManager(this, name, this.pm.type);
    }
}
