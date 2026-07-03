// ============================================================================
// coordenacao.js — Coordenação Humano-Máquina (paradigma Indústria 5.0)
//
// O "cérebro" logístico do BoxToCar. Dado o layout do armazém (grelha 2D) e a
// prateleira a recolher, calcula, através de algoritmos exatos de procura em
// grelha (BFS — caminho mais curto), o PONTO DE ENCONTRO eficiente entre o
// operador humano e o robô virtual (AMR), bem como as rotas de ambos.
//
// Modelo: o robô circula pelo CORREDOR PRINCIPAL (perímetro da grelha — rotas
// fixas e previsíveis); o operador vai à prateleira, recolhe o artigo (destreza)
// e transporta-o apenas até ao ponto de encontro mais próximo no corredor, onde
// o entrega ao robô (transporte pesado). O ponto de encontro é escolhido para
// MINIMIZAR a distância percorrida pelo operador COM carga.
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
// planearRecolha: função principal (pura). Recebe as prateleiras, as dimensões,
// a posição da prateleira-alvo e (opcionalmente) o depósito. Devolve o plano de
// coordenação: ponto de encontro, rotas e métricas.
// ----------------------------------------------------------------------------
function planearRecolha({ prateleiras, maxX, maxY, alvoX, alvoY, deposito }) {
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
  let pontoEncontro = null, distOperadorComCarga = Infinity;
  for (const [k, d] of distAcesso) {
    const [x, y] = k.split(',').map(Number);
    if (ehCorredorPrincipal(x, y, maxX, maxY) && d < distOperadorComCarga) {
      distOperadorComCarga = d; pontoEncontro = { x, y };
    }
  }
  // Se não houver corredor de perímetro alcançável, o encontro é o próprio acesso.
  if (!pontoEncontro) { pontoEncontro = cellsAcesso[0]; distOperadorComCarga = 0; }

  // 4. Rota do robô: do depósito até ao ponto de encontro (algoritmo exato).
  const { distancias: distDep, anteriores: antDep } = bfs([dep], ocupadas, maxX, maxY);
  const distRobo = distDep.get(CHAVE(pontoEncontro.x, pontoEncontro.y));
  const rotaRobo = reconstruirCaminho(antDep, pontoEncontro);

  // 5. Rota do operador COM carga: da recolha até ao ponto de encontro.
  const rotaOperador = reconstruirCaminho(antAcesso, pontoEncontro);

  // 6. Métricas de eficiência (Indústria 5.0):
  //    - sem robô, o operador teria de transportar a carga até ao depósito.
  const distSemRobo = distAcesso.get(CHAVE(dep.x, dep.y));
  const poupanca = (distSemRobo != null) ? distSemRobo - distOperadorComCarga : null;
  const poupancaPct = (distSemRobo && distSemRobo > 0) ? Math.round((poupanca / distSemRobo) * 100) : null;

  return {
    prateleira: { x: alvoX, y: alvoY },
    deposito: dep,
    pontoEncontro,
    rotaOperador,           // recolha -> ponto de encontro (com carga)
    rotaRobo,               // depósito -> ponto de encontro
    metricas: {
      operadorComCarga: distOperadorComCarga,   // passos do operador com carga
      roboAteEncontro: (distRobo != null) ? distRobo : null,
      operadorSemRobo: (distSemRobo != null) ? distSemRobo : null, // se levasse ao depósito
      poupancaOperador: poupanca,               // passos poupados ao operador
      poupancaPercent: poupancaPct              // % de esforço poupado
    }
  };
}

module.exports = { planearRecolha, bfs, ehCorredorPrincipal, escolherDeposito, reconstruirCaminho };
