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
    // Ignore full-line comments so a commented-out `# export PORT=9999` example
    // isn't mistaken for the real port.
    const code = content
      .split('\n')
      .filter(line => !/^\s*#/.test(line))
      .join('\n');
    const env = {};
    let hasFlask = false;
    let hasExpress = false;
    let hasStreamlit = false;

    // Detect framework/type
    if (content.includes('flask') || (content.includes('python') && content.includes('app.py'))) {
      hasFlask = true;
    }
    if (content.includes('node') || content.includes('npm') || content.includes('yarn')) {
      hasExpress = true;
    }
    if (content.includes('streamlit')) {
      hasStreamlit = true;
    }

    // Extract PORT from various patterns.
    //
    // IMPORTANT: assignment forms require a literal `=` (never a bare `[=\s]+`).
    // A `[=\s]+` class matches newlines, so a line like `export PORT HOST`
    // followed by the next statement would let `HOST` swallow the following
    // token — the class of bug that turned `export PORT HOST\necho ...` into
    // `HOST=echo`. Flag forms (`--port 8080`) allow only same-line space/tab.
    const portPatterns = [
      // `${PORT:-8080}` / `${PORT:=8080}` default-value forms (the manager's own
      // scaffolded scripts, and the `: "${PORT:=8059}"` idiom). Capture the
      // fallback so imported programs get a URL. Must come first.
      /\$\{\s*PORT\s*:[-=]\s*(\d{2,5})/i,
      /\bPORT[ \t]*=[ \t]*["']?(\d{2,5})\b/i,          // PORT=8080 / export PORT=8080
      /--port[ \t]*=?[ \t]*["']?(\d{2,5})\b/i,         // --port 8080 / --port=8080
      /--bind[ \t]+["']?[^ \t"':]*:(\d{2,5})\b/i,      // gunicorn/uvicorn --bind host:port
      /-p[ \t]+["']?(\d{2,5})\b/i,                     // -p 8080
      /\blisten[ \t]+["']?(\d{2,5})\b/i                // listen 8080
    ];

    for (const pattern of portPatterns) {
      const match = code.match(pattern);
      if (match && match[1]) {
        env.PORT = match[1];
        break;
      }
    }

    // Extract HOST — accept a hostname too, not just a numeric IP. Same rule as
    // PORT: the env-assignment form requires a literal `=` so a bare `export
    // PORT HOST` can't capture the next line's token.
    const hostPatterns = [
      /\$\{\s*HOST\s*:[-=]\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/i,  // ${HOST:=0.0.0.0}
      /\bHOST[ \t]*=[ \t]*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/i,     // HOST=0.0.0.0
      /--host[ \t]*=?[ \t]*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/i     // --host 0.0.0.0
    ];

    for (const pattern of hostPatterns) {
      const match = code.match(pattern);
      if (match && match[1]) {
        env.HOST = match[1];
        break;
      }
    }

    // Extract other environment variables. Require a literal `=` immediately after
    // the key (shell assignment syntax — no spaces around `=`). A quoted value may
    // contain spaces; an unquoted value stops at the first whitespace, inline
    // comment, or shell operator so `export DEBUG=1 && npm start` records "1", not
    // "1 && npm start", and `export X=y  # note` records "y", not "y  # note".
    const envVarPattern = /export\s+([A-Z_][A-Z0-9_]*)=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#;&|"']*))/gi;
    let match;
    while ((match = envVarPattern.exec(code)) !== null) {
      const key = match[1];
      const value = (match[2] !== undefined ? match[2]
        : match[3] !== undefined ? match[3]
        : match[4] || '').trim();
      // Skip PATH/HOME, keys already set (PORT/HOST), empty values, and anything
      // holding an unresolved variable reference ($VAR / ${VAR}) — storing that
      // literal would inject an unexpanded token into config.json.
      const looksLikeVarRef = /\$\{?[A-Za-z_]/.test(value);
      if (key !== 'PATH' && key !== 'HOME' && !env[key] && value && !looksLikeVarRef) {
        env[key] = value;
      }
    }

    // Validate PORT: numeric and within the TCP range. Normalize leading zeros.
    if (env.PORT) {
      const n = Number(env.PORT);
      if (!/^\d+$/.test(env.PORT) || n < 1 || n > 65535) {
        console.warn(`  ⚠️  Invalid PORT value "${env.PORT}" (not a 1–65535 port), removing`);
        delete env.PORT;
      } else {
        env.PORT = String(n);
      }
    }

    // Drop a HOST that is really an unresolved variable reference.
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
  // Throw rather than process.exit — this module is required by the long-running
  // server (runRediscovery / auto-discovery), and exiting here would take the
  // whole manager (and its process tracking) down. The CLI main() catches it.
  if (!fs.existsSync(projectsDir)) {
    throw new Error(`Directory not found: ${projectsDir}`);
  }

  const projects = [];
  const usedIds = new Set();
  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip backup folders
    if (entry.name.endsWith('.backup')) continue;

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

    // Generate program ID (lowercase, hyphenated, ascii-only). Fall back to a
    // stable slug when sanitizing leaves nothing (e.g. an all-non-ASCII name), and
    // suffix on collision so two folders that normalize to the same id (e.g.
    // "Web App" and "web-app") don't overwrite each other or fail config validation.
    let baseId = entry.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
    if (!baseId) baseId = 'program';
    let id = baseId;
    let dedup = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${dedup++}`;
    }
    usedIds.add(id);

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

  let projects;
  try {
    projects = discoverProjects(absoluteProjectsDir);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

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
