#!/usr/bin/env node

/**
 * Auto-Discovery Script for HTTP Server Manager
 *
 * Scans a directory for projects with Start.sh files and automatically
 * generates config.json with intelligent defaults.
 *
 * Usage:
 *   node discover-projects.js [projects-dir] [--output config.json] [--dry-run]
 *
 * Examples:
 *   node discover-projects.js ../projects
 *   node discover-projects.js /home/user/projects --output config.json
 *   node discover-projects.js ../projects --dry-run
 */

const fs = require('fs');
const path = require('path');

// Configuration
const PROJECTS_DIR = process.argv[2] || path.join(__dirname, '../projects');
const OUTPUT_FILE = process.argv.includes('--output')
  ? process.argv[process.argv.indexOf('--output') + 1]
  : path.join(__dirname, 'config.json');
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Parse Start.sh file to extract environment variables and configuration
 */
function parseStartScript(scriptPath) {
  try {
    const content = fs.readFileSync(scriptPath, 'utf8');
    const env = {};
    let hasFlask = false;
    let hasExpress = false;
    let hasStreamlit = false;

    // Detect framework/type
    if (content.includes('flask') || content.includes('python') && content.includes('app.py')) {
      hasFlask = true;
    }
    if (content.includes('node') || content.includes('npm') || content.includes('yarn')) {
      hasExpress = true;
    }
    if (content.includes('streamlit')) {
      hasStreamlit = true;
    }

    // Extract PORT from various patterns
    const portPatterns = [
      /PORT[=\s]+["']?(\d+)["']?/i,
      /--port[=\s]+["']?(\d+)["']?/i,
      /--bind[=\s]+["']?[^\s"']*?:(\d+)["']?/i, // gunicorn/uvicorn --bind host:port
      /-p[=\s]+["']?(\d+)["']?/i,
      /listen[=\s]+["']?(\d+)["']?/i,
      /port[=\s]+["']?(\d+)["']?/i
    ];

    for (const pattern of portPatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        env.PORT = match[1];
        break;
      }
    }

    // Extract HOST
    const hostPatterns = [
      /HOST[=\s]+["']?([0-9.]+)["']?/i,
      /--host[=\s]+["']?([0-9.]+)["']?/i,
      /-h[=\s]+["']?([0-9.]+)["']?/i
    ];

    for (const pattern of hostPatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        env.HOST = match[1];
        break;
      }
    }

    // Extract other environment variables
    const envVarPattern = /export\s+([A-Z_][A-Z0-9_]*)[=\s]+["']?([^"'\n]+)["']?/gi;
    let match;
    while ((match = envVarPattern.exec(content)) !== null) {
      const [, key, value] = match;
      // Skip PATH, HOME, and keys already set (PORT, HOST)
      // Also skip variable references like $HOST, $PORT, ${VAR}
      const trimmedValue = value.trim();
      if (key !== 'PATH' && key !== 'HOME' && !env[key] && !trimmedValue.startsWith('$')) {
        env[key] = trimmedValue;
      }
    }

    // Validate PORT is numeric, remove if not
    if (env.PORT && !/^\d+$/.test(env.PORT)) {
      console.warn(`  ⚠️  Invalid PORT value "${env.PORT}" (not numeric), removing`);
      delete env.PORT;
    }

    // Validate HOST is valid IP or hostname
    if (env.HOST && env.HOST.startsWith('$')) {
      console.warn(`  ⚠️  Invalid HOST value "${env.HOST}" (variable reference), removing`);
      delete env.HOST;
    }

    return { env, hasFlask, hasExpress, hasStreamlit };
  } catch (err) {
    console.warn(`Warning: Could not parse ${scriptPath}:`, err.message);
    return { env: {}, hasFlask: false, hasExpress: false, hasStreamlit: false };
  }
}

/**
 * Try to detect project metadata from various sources
 */
function detectProjectMetadata(projectPath) {
  const metadata = {
    name: path.basename(projectPath),
    description: null,
    framework: null
  };

  // Try to read package.json (Node.js projects)
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      metadata.name = pkg.name || metadata.name;
      metadata.description = pkg.description;
      metadata.framework = 'Node.js';
    } catch (err) {
      // Ignore parse errors
    }
  }

  // Try to read requirements.txt (Python projects)
  const requirementsPath = path.join(projectPath, 'requirements.txt');
  if (fs.existsSync(requirementsPath)) {
    try {
      const requirements = fs.readFileSync(requirementsPath, 'utf8');
      if (requirements.includes('flask')) {
        metadata.framework = 'Flask';
      } else if (requirements.includes('django')) {
        metadata.framework = 'Django';
      } else if (requirements.includes('fastapi')) {
        metadata.framework = 'FastAPI';
      } else if (requirements.includes('streamlit')) {
        metadata.framework = 'Streamlit';
      } else {
        metadata.framework = 'Python';
      }
    } catch (err) {
      // Ignore
    }
  }

  // Try to read README.md
  const readmePath = path.join(projectPath, 'README.md');
  if (fs.existsSync(readmePath) && !metadata.description) {
    try {
      const readme = fs.readFileSync(readmePath, 'utf8');
      // Extract first non-empty line that's not a heading
      const lines = readme.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      if (lines.length > 0) {
        metadata.description = lines[0].trim().substring(0, 100);
      }
    } catch (err) {
      // Ignore
    }
  }

  return metadata;
}

/**
 * Generate a friendly display name from project path
 */
function generateDisplayName(projectPath, metadata) {
  let name = metadata.name || path.basename(projectPath);

  // Convert common patterns to readable names
  name = name
    .replace(/[-_]/g, ' ')  // Replace hyphens and underscores with spaces
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))  // Capitalize
    .join(' ');

  return name;
}

/**
 * Discover all projects in a directory
 */
function discoverProjects(projectsDir) {
  if (!fs.existsSync(projectsDir)) {
    console.error(`Error: Directory not found: ${projectsDir}`);
    process.exit(1);
  }

  const projects = [];
  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const projectPath = path.join(projectsDir, entry.name);
    const startScriptPath = path.join(projectPath, 'Start.sh');

    // Skip if no Start.sh
    if (!fs.existsSync(startScriptPath)) {
      console.log(`  ⊗ Skipping ${entry.name} (no Start.sh found)`);
      continue;
    }

    console.log(`  ✓ Found project: ${entry.name}`);

    // Parse Start.sh
    const { env, hasFlask, hasExpress, hasStreamlit } = parseStartScript(startScriptPath);

    // Detect metadata
    const metadata = detectProjectMetadata(projectPath);

    // Generate program ID (lowercase, no spaces)
    const id = entry.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    // Generate display name
    const displayName = generateDisplayName(projectPath, metadata);

    // Ensure HOST is set to 0.0.0.0 for network access
    if (!env.HOST) {
      env.HOST = '0.0.0.0';
    }

    // Build program config
    const program = {
      id,
      name: displayName,
      path: projectPath,
      env
    };

    // Add comment with metadata
    const comments = [];
    if (metadata.framework) {
      comments.push(metadata.framework);
    }
    if (metadata.description) {
      comments.push(metadata.description);
    }

    if (comments.length > 0) {
      program.comment = comments.join(' - ');
    }

    projects.push(program);
  }

  return projects;
}

/**
 * Generate complete config.json
 */
function generateConfig(projects) {
  return {
    hostname: "auto",
    programs: projects
  };
}

/**
 * Main execution
 */
function main() {
  console.log('🔍 HTTP Server Manager - Project Discovery\n');
  // Ensure PROJECTS_DIR is absolute
  const absoluteProjectsDir = path.resolve(PROJECTS_DIR);
  console.log(`Scanning directory: ${absoluteProjectsDir}\n`);

  const projects = discoverProjects(absoluteProjectsDir);

  console.log(`\n📊 Discovery Summary:`);
  console.log(`  Total projects found: ${projects.length}`);
  console.log(`  Projects with PORT: ${projects.filter(p => p.env.PORT).length}`);

  if (projects.length === 0) {
    console.log('\n⚠️  No projects with Start.sh found!');
    console.log('   Make sure your projects have a Start.sh file in their root directory.');
    process.exit(1);
  }

  const config = generateConfig(projects);

  if (DRY_RUN) {
    console.log('\n📝 Generated Configuration (--dry-run, not saved):\n');
    console.log(JSON.stringify(config, null, 2));
  } else {
    // Backup existing config if it exists
    if (fs.existsSync(OUTPUT_FILE)) {
      const backupFile = OUTPUT_FILE + '.backup.' + Date.now();
      fs.copyFileSync(OUTPUT_FILE, backupFile);
      console.log(`\n💾 Backed up existing config to: ${backupFile}`);
    }

    // Write new config
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(config, null, 2), 'utf8');
    console.log(`\n✅ Configuration written to: ${OUTPUT_FILE}`);
    console.log('\nNext steps:');
    console.log('  1. Review the generated config.json');
    console.log('  2. Start the manager: npm start');
    console.log('  3. Access the web UI to manage your programs');
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { discoverProjects, generateConfig, parseStartScript };
