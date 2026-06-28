import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const REQUIREMENTS = join(PROJECT_ROOT, "GeekedTest-main", "requirements.txt");

function findPython() {
  for (const candidate of ["python", "python3", "py"]) {
    try {
      execSync(`"${candidate}" --version`, { stdio: "pipe", timeout: 5000 });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function getPipCommand(pythonCmd) {
  const result = spawnSync(pythonCmd, ["-m", "pip", "--version"], { stdio: "pipe", timeout: 10000 });
  if (result.status === 0) {
    return [pythonCmd, "-m", "pip"];
  }

  for (const candidate of ["pip3", "pip"]) {
    try {
      execSync(`"${candidate}" --version`, { stdio: "pipe", timeout: 5000 });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

console.log("🔍 Verificando ambiente Python para o Geetest solver...");

const python = findPython();
if (!python) {
  console.log("⚠️  Python nao encontrado. O captcha solver Geetest nao estara disponivel.");
  console.log("   Instale Python 3 e execute: npm run setup:python");
  process.exit(0);
}

console.log(`✅ Python encontrado: ${python}`);

if (!existsSync(REQUIREMENTS)) {
  console.log(`✅ Nenhum requirements.txt encontrado; pulando instalacao.`);
  process.exit(0);
}

const pip = getPipCommand(python);
if (!pip) {
  console.log("⚠️  pip nao encontrado. Instale manualmente as dependencias:");
  console.log(`   pip install -r "${REQUIREMENTS}"`);
  process.exit(0);
}

console.log(`📦 Instalando dependencias Python de ${REQUIREMENTS}...`);
let pipCmd;
let pipArgs;

if (Array.isArray(pip)) {
  pipCmd = pip[0];
  pipArgs = [...pip.slice(1), "install", "-r", REQUIREMENTS];
} else {
  pipCmd = pip;
  pipArgs = ["install", "-r", REQUIREMENTS];
}

const result = spawnSync(pipCmd, pipArgs, {
  stdio: "inherit",
  timeout: 300000,
  cwd: PROJECT_ROOT
});

if (result.status === 0) {
  console.log("✅ Dependencias Python do Geetest solver instaladas com sucesso.");
} else {
  console.log("⚠️  Falha ao instalar dependencias Python. Tente manualmente:");
  console.log(`   pip install -r "${REQUIREMENTS}"`);
}
