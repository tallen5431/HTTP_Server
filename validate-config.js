#!/usr/bin/env node

/**
 * Config Validator and Fixer
 *
 * This script validates and fixes common issues in config.json:
 * - Invalid PORT values (non-numeric)
 * - Invalid HOST values (variable references)
 * - Missing required fields
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.argv[2] || './config.json';

function validateAndFixConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    console.error(`❌ Config file not found: ${configPath}`);
    return false;
  }

  console.log(`🔍 Validating ${configPath}...\n`);

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);
    let modified = false;
    let issues = 0;

    if (!config.programs || !Array.isArray(config.programs)) {
      console.error('❌ Config must have a "programs" array');
      return false;
    }

    config.programs.forEach((program, index) => {
      console.log(`Checking program ${index + 1}: ${program.name || program.id}`);

      // Validate PORT
      if (program.env && program.env.PORT) {
        const port = program.env.PORT;
        if (!/^\d+$/.test(port)) {
          console.log(`  ⚠️  Invalid PORT: "${port}" (not numeric)`);
          console.log(`  🔧 Removing invalid PORT value`);
          delete program.env.PORT;
          modified = true;
          issues++;
        } else {
          console.log(`  ✅ PORT: ${port}`);
        }
      } else {
        console.log(`  ℹ️  No PORT defined`);
      }

      // Validate HOST
      if (program.env && program.env.HOST) {
        const host = program.env.HOST;
        if (host.startsWith('$') || host.includes('${')) {
          console.log(`  ⚠️  Invalid HOST: "${host}" (variable reference)`);
          console.log(`  🔧 Setting to 0.0.0.0`);
          program.env.HOST = '0.0.0.0';
          modified = true;
          issues++;
        } else {
          console.log(`  ✅ HOST: ${host}`);
        }
      }

      console.log('');
    });

    if (modified) {
      // Backup original
      const backupPath = `${configPath}.backup.${Date.now()}`;
      fs.copyFileSync(configPath, backupPath);
      console.log(`💾 Backed up original to: ${backupPath}\n`);

      // Save fixed config
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      console.log(`✅ Fixed ${issues} issue(s) and saved to: ${configPath}\n`);
      console.log(`📋 Summary:`);
      console.log(`   - Total programs: ${config.programs.length}`);
      console.log(`   - Issues fixed: ${issues}`);
    } else {
      console.log(`✅ No issues found! Config is valid.`);
    }

    return true;
  } catch (err) {
    console.error(`❌ Error processing config:`, err.message);
    return false;
  }
}

// Main
console.log('Config Validator and Fixer\n');
console.log('==========================\n');

if (process.argv.includes('--help')) {
  console.log('Usage:');
  console.log('  node validate-config.js [config-file]');
  console.log('');
  console.log('Examples:');
  console.log('  node validate-config.js');
  console.log('  node validate-config.js ./config.json');
  console.log('  node validate-config.js /path/to/custom-config.json');
  process.exit(0);
}

const success = validateAndFixConfig(CONFIG_FILE);
process.exit(success ? 0 : 1);
