// ============================================================================
// coordenacao.js — Cálculo de distâncias e rotas sobre a grelha (BFS)
//
// Esta é a peça de mais baixo nível do sistema: dado o layout do armazém
// (grelha 2D), calcula distâncias e rotas entre pontos por procura em largura
// (BFS — exata, mas ingénua; não decide nada por si). É usada por baixo dos
// três algoritmos de planeamento (algoritmos.js — exato, guloso e
// meta-heurística) e da decisão multicritério (custoDecisao.js), que são
// quem efetivamente decide a atribuição humano/robô e a ordem das recolhas.
//
// Modelo espacial: o robô circula pelo CORREDOR PRINCIPAL (perímetro da
// grelha — rotas fixas e previsíveis, compatível com robôs de trilho fixo ou
// perímetro do catálogo em robos.js); o operador vai à prateleira, recolhe o
// artigo e, quando a decisão multicritério assim o determinar, transporta-o
// apenas até ao ponto de encontro mais próximo no corredor, onde o entrega ao
// robô.
// ============================================================================

const CHAVE = (x, y) => `${x},${y}`;
const MOVIMENTOS = [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }];

// Uma célula pertence ao corredor principal se estiver no perímetro da grelha.
function ehCorredorPrincipal(x, y, maxX, maxY) {
  return x === 1 || x === maxX || y === 1 || y === maxY;
}

// BFS multi-origem sobre as células livres (as prateleiras são obstáculos).
// Devolve: distancias (Map chave->passos) e anteriores (para reconstruir caminho).
function bfs(origens, ocupadas, maxX, maxY) {
  const distancias = new Map();
  const anteriores = new Map();
  const fila = [];
  for (const o of origens) {
    const k = CHAVE(o.x, o.y);
    if (ocupadas.has(k)) continue;
    distancias.set(k, 0);
    anteriores.set(k, null);
    fila.push(o);
  }
  let i = 0;
  while (i < fila.length) {
    const atual = fila[i++];
    const dAtual = distancias.get(CHAVE(atual.x, atual.y));
    for (const m of MOVIMENTOS) {
      const nx = atual.x + m.dx, ny = atual.y + m.dy;
      if (nx < 1 || nx > maxX || ny < 1 || ny > maxY) continue;
      const k = CHAVE(nx, ny);
      if (ocupadas.has(k) || distancias.has(k)) continue;
      distancias.set(k, dAtual + 1);
      anteriores.set(k, { x: atual.x, y: atual.y });
      fila.push({ x: nx, y: ny });
    }
  }
  return { distancias, anteriores };
}

// Reconstrói o caminho (lista de células) até um destino, a partir dos "anteriores".
function reconstruirCaminho(anteriores, destino) {
  const caminho = [];
  let atual = destino;
  while (atual) {
    caminho.unshift({ x: atual.x, y: atual.y });
    atual = anteriores.get(CHAVE(atual.x, atual.y));
  }
  return caminho;
}

// Vizinhos livres de uma prateleira (as células onde o operador pode estar para recolher).
function acessos(sx, sy, ocupadas, maxX, maxY) {
  const res = [];
  for (const m of MOVIMENTOS) {
    const nx = sx + m.dx, ny = sy + m.dy;
    if (nx < 1 || nx > maxX || ny < 1 || ny > maxY) continue;
    if (!ocupadas.has(CHAVE(nx, ny))) res.push({ x: nx, y: ny });
  }
  return res;
}

// Escolhe o depósito/ponto de expedição: célula (1,1) se livre, senão o
// corredor livre mais próximo dela.
function escolherDeposito(ocupadas, maxX, maxY) {
  if (!ocupadas.has(CHAVE(1, 1))) return { x: 1, y: 1 };
  const { distancias } = bfs([{ x: 1, y: 1 }], ocupadas, maxX, maxY); // 1,1 ocupada -> vazio
  // procura a célula livre mais próxima de (1,1) por varrimento
  let melhor = null, best = Infinity;
  for (let y = 1; y <= maxY; y++) for (let x = 1; x <= maxX; x++) {
    if (ocupadas.has(CHAVE(x, y))) continue;
    const d = Math.abs(x - 1) + Math.abs(y - 1);
    if (d < best) { best = d; melhor = { x, y }; }
  }
  return melhor || { x: 1, y: 1 };
}

// ----------------------------------------------------------------------------
// calcularDistanciasTarefa: núcleo puro de cálculo (sem opiniões sobre custo).
// Dado o layout e uma prateleira-alvo, devolve o ponto de encontro no corredor
// principal e as distâncias/rotas relevantes. É a peça reutilizada tanto pelo
// endpoint de plano único como pelos três algoritmos de planeamento
// (algoritmos.js), que decidem — usando custoDecisao.js — se vale a pena usar
// o robô para cada tarefa.
// ----------------------------------------------------------------------------
function calcularDistanciasTarefa({ prateleiras, maxX, maxY, alvoX, alvoY, deposito }) {
  const ocupadas = new Set(prateleiras.map(p => CHAVE(p.PosX, p.PosY)));

  if (!ocupadas.has(CHAVE(alvoX, alvoY))) {
    return { erro: 'A posição alvo não corresponde a uma prateleira.' };
  }

  const dep = deposito || escolherDeposito(ocupadas, maxX, maxY);

  // 1. Acessos à prateleira (onde o operador recolhe o artigo).
  const cellsAcesso = acessos(alvoX, alvoY, ocupadas, maxX, maxY);
  if (cellsAcesso.length === 0) {
    return { erro: 'A prateleira está bloqueada (sem acesso livre à volta).' };
  }

  // 2. BFS a partir dos acessos: distância de qualquer célula livre até à recolha.
  const { distancias: distAcesso, anteriores: antAcesso } = bfs(cellsAcesso, ocupadas, maxX, maxY);

  // 3. Ponto de encontro = célula do corredor principal com menor distância à recolha.
  let pontoEncontro = null, distOperadorAteEncontro = Infinity;
  for (const [k, d] of distAcesso) {
    const [x, y] = k.split(',').map(Number);
    if (ehCorredorPrincipal(x, y, maxX, maxY) && d < distOperadorAteEncontro) {
      distOperadorAteEncontro = d; pontoEncontro = { x, y };
    }
  }
  // Se não houver corredor de perímetro alcançável, o encontro é o próprio acesso.
  if (!pontoEncontro) { pontoEncontro = cellsAcesso[0]; distOperadorAteEncontro = 0; }

  // 4. Rota do robô: do depósito até ao ponto de encontro (algoritmo exato).
  const { distancias: distDep, anteriores: antDep } = bfs([dep], ocupadas, maxX, maxY);
  const distRoboAteEncontro = distDep.get(CHAVE(pontoEncontro.x, pontoEncontro.y));
  const rotaRobo = reconstruirCaminho(antDep, pontoEncontro);

  // 5. Rota do operador COM carga: da recolha até ao ponto de encontro.
  const rotaOperador = reconstruirCaminho(antAcesso, pontoEncontro);

  // 6. Distância do operador se seguisse sozinho até ao depósito (sem robô).
  const distOperadorSemRobo = distAcesso.get(CHAVE(dep.x, dep.y));

  return {
    prateleira: { x: alvoX, y: alvoY },
    deposito: dep,
    pontoEncontro,
    rotaOperador,
    rotaRobo,
    distOperadorAteEncontro,
    distRoboAteEncontro: (distRoboAteEncontro != null) ? distRoboAteEncontro : null,
    distOperadorSemRobo: (distOperadorSemRobo != null) ? distOperadorSemRobo : null,
  };
}

// ----------------------------------------------------------------------------
// planearRecolha: mantido para compatibilidade com o backoffice web e a app
// (endpoint de plano único). Envolve calcularDistanciasTarefa e traduz o
// resultado no formato de métricas (passos, poupança) já usado nas interfaces.
// ----------------------------------------------------------------------------
function planearRecolha({ prateleiras, maxX, maxY, alvoX, alvoY, deposito }) {
  const r = calcularDistanciasTarefa({ prateleiras, maxX, maxY, alvoX, alvoY, deposito });
  if (r.erro) return r;

  const poupanca = (r.distOperadorSemRobo != null) ? r.distOperadorSemRobo - r.distOperadorAteEncontro : null;
  const poupancaPct = (r.distOperadorSemRobo && r.distOperadorSemRobo > 0) ? Math.round((poupanca / r.distOperadorSemRobo) * 100) : null;

  return {
    prateleira: r.prateleira,
    deposito: r.deposito,
    pontoEncontro: r.pontoEncontro,
    rotaOperador: r.rotaOperador,
    rotaRobo: r.rotaRobo,
    metricas: {
      operadorComCarga: r.distOperadorAteEncontro,
      roboAteEncontro: r.distRoboAteEncontro,
      operadorSemRobo: r.distOperadorSemRobo,
      poupancaOperador: poupanca,
      poupancaPercent: poupancaPct
    }
  };
}

module.exports = { planearRecolha, calcularDistanciasTarefa, bfs, ehCorredorPrincipal, escolherDeposito, reconstruirCaminho, acessos };
