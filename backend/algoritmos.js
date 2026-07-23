// ============================================================================
// algoritmos.js — Os três algoritmos de planeamento de recolhas
//
// O problema: dado um conjunto de recolhas pendentes, decidir para cada uma
// se vai por humano+robô ou por humano sozinho, e por que ORDEM o operador as
// executa, minimizando o custo total (esforço do operador + tempo do robô,
// calculado por custoDecisao.js). A ordem importa porque a posição onde o
// operador fica no fim de uma tarefa (o ponto de encontro, ou o depósito)
// condiciona a distância até à tarefa seguinte — por isso a atribuição
// (humano/robô) e a sequência não podem ser otimizadas em separado.
//
// Este é o problema que justifica uma heurística: o espaço de procura cresce
// em N! × 2^N (ordens × atribuições), pelo que a busca exaustiva só é viável
// para poucas tarefas.
//
//   resolverExato          — força bruta: testa todas as combinações.
//                             Só serve para N pequeno (≤ LIMITE_EXATO), mas dá
//                             o ótimo e serve de referência para os outros dois.
//   resolverGuloso          — heurística construtiva: em cada passo, decide a
//                             atribuição da tarefa mais próxima e avança.
//                             Rápida, não é ótima.
//   resolverMetaheuristica  — recozimento simulado a partir da solução gulosa:
//                             troca atribuições e ordens, guiado pela função
//                             de custo, aceitando por vezes soluções piores
//                             para escapar a mínimos locais.
//
// A BFS (coordenacao.js) é usada por baixo dos três só para medir distâncias;
// não decide nada.
// ============================================================================

const { bfs, acessos, escolherDeposito, calcularDistanciasTarefa } = require('./coordenacao');
const { custoTarefaComAtribuicao, opcaoRoboViavel, tempoEmSegundos } = require('./custoDecisao');

const LIMITE_EXATO = 7; // 7! x 2^7 ~ 645 mil combinações; acima disto, recusa-se (ver relatório)
const SEMENTE_PREDEFINIDA = 42; // reprodutibilidade por omissão da meta-heurística (ver resolverMetaheuristica)

function chave(x, y) { return `${x},${y}`; }

// Gerador pseudoaleatório determinístico (mulberry32) — Math.random() não
// aceita semente, o que tornava os resultados da meta-heurística diferentes
// a cada execução (Tabelas 4/8/9 do relatório). Com semente fixa, o mesmo
// cenário produz sempre a mesma solução; um chamador que queira variar entre
// execuções passa opcoes.semente explicitamente.
function criarGeradorAleatorio(semente) {
  let estado = semente >>> 0;
  return function random() {
    estado |= 0; estado = (estado + 0x6D2B79F5) | 0;
    let t = Math.imul(estado ^ (estado >>> 15), 1 | estado);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Resolve o depósito uma única vez (se não vier definido) para que a posição
// inicial do operador seja consistente entre a preparação das tarefas e a
// avaliação da sequência — sem isto, cada função calcularia um depósito
// possivelmente diferente.
function normalizarContexto(ctx) {
  if (ctx.deposito) return ctx;
  const ocupadas = new Set(ctx.prateleiras.map(p => chave(p.PosX, p.PosY)));
  const deposito = escolherDeposito(ocupadas, ctx.maxX, ctx.maxY);
  return { ...ctx, deposito };
}

// As posições de origem possíveis do operador, ao longo de uma sequência,
// são poucas: o depósito e um ponto de encontro por tarefa (no máximo N+1
// valores distintos para N tarefas). O exato reavalia a mesma sequência de
// posições em cada permutação × atribuição, pelo que a mesma origem volta a
// aparecer muitas vezes; cacheBfs (por chamada ao algoritmo, nunca partilhada
// entre pedidos) evita recalcular a BFS a partir da mesma origem repetida.
function distanciaPosicaoAPrateleira(pos, alvoX, alvoY, ocupadas, maxX, maxY, cacheBfs) {
  const cellsAcesso = acessos(alvoX, alvoY, ocupadas, maxX, maxY);
  const chavePos = chave(pos.x, pos.y);
  let distancias;
  if (cacheBfs && cacheBfs.has(chavePos)) {
    distancias = cacheBfs.get(chavePos);
  } else {
    distancias = bfs([pos], ocupadas, maxX, maxY).distancias;
    if (cacheBfs) cacheBfs.set(chavePos, distancias);
  }
  let min = Infinity;
  for (const c of cellsAcesso) {
    const d = distancias.get(chave(c.x, c.y));
    if (d != null && d < min) min = d;
  }
  return min;
}

// Pré-calcula, para cada tarefa (independente da ordem), o núcleo geométrico
// (ponto de encontro, distâncias) — reutilizado por todas as combinações.
function prepararTarefas(tarefas, { prateleiras, maxX, maxY, deposito, robo, velocidadeHumanoMS }) {
  return tarefas.map(tarefa => {
    const nucleo = calcularDistanciasTarefa({ prateleiras, maxX, maxY, alvoX: tarefa.PosX, alvoY: tarefa.PosY, deposito });
    const roboViavel = !nucleo.erro && opcaoRoboViavel(robo, tarefa);
    return { tarefa, nucleo, roboViavel };
  });
}

// Custo de uma tarefa preparada sob uma atribuição concreta.
function custoTarefa(prep, atribuicao, robo, velocidadeHumanoMS) {
  return custoTarefaComAtribuicao({
    atribuicao,
    distanciaOperadorAteEncontro: prep.nucleo.distOperadorAteEncontro,
    distanciaRoboAteEncontro: prep.nucleo.distRoboAteEncontro,
    distanciaOperadorSemRobo: prep.nucleo.distOperadorSemRobo,
    velocidadeHumanoMS,
    robo,
    artigo: prep.tarefa,
  });
}

// Custo total de uma sequência completa (ordem + atribuições), incluindo a
// deslocação (sem carga) do operador entre o fim de uma tarefa e o início da
// seguinte. É a função objetivo que os três algoritmos minimizam.
function avaliarSequencia(preparadas, ordem, atribuicoes, ctx, cacheBfs) {
  const { prateleiras, maxX, maxY, deposito, robo, velocidadeHumanoMS } = ctx;
  const ocupadas = new Set(prateleiras.map(p => chave(p.PosX, p.PosY)));

  let pos = deposito;
  let custoTotal = 0;
  let tempoOperadorTotal = 0;
  let tempoRoboTotal = 0;
  const detalhe = [];

  for (const idx of ordem) {
    const prep = preparadas[idx];
    const atribuicao = atribuicoes[idx];
    const desloc = distanciaPosicaoAPrateleira(pos, prep.tarefa.PosX, prep.tarefa.PosY, ocupadas, maxX, maxY, cacheBfs);
    const tempoDesloc = tempoEmSegundos(Number.isFinite(desloc) ? desloc : 0, velocidadeHumanoMS);
    const custo = custoTarefa(prep, atribuicao, robo, velocidadeHumanoMS);

    custoTotal += tempoDesloc + custo.custoTotal;
    tempoOperadorTotal += tempoDesloc + custo.tempoOperadorH;
    tempoRoboTotal += custo.tempoRoboH;
    detalhe.push({
      tarefaID: prep.tarefa.TarefaID, artigo: prep.tarefa.Nome, atribuicao,
      deslocacao: desloc, tempoOperadorH: custo.tempoOperadorH, tempoRoboH: custo.tempoRoboH,
    });

    pos = (atribuicao === 'humano_robo') ? prep.nucleo.pontoEncontro : prep.nucleo.deposito;
  }

  return { custoTotal, tempoOperadorTotal, tempoRoboTotal, detalhe };
}

// Atribuição "gulosa": a melhor opção local para cada tarefa, ignorando a sequência.
function atribuicaoGulosaDeTarefa(prep, robo, velocidadeHumanoMS) {
  if (!prep.roboViavel) return 'humano_sozinho';
  const semRobo = custoTarefa(prep, 'humano_sozinho', robo, velocidadeHumanoMS);
  const comRobo = custoTarefa(prep, 'humano_robo', robo, velocidadeHumanoMS);
  return comRobo.custoTotal <= semRobo.custoTotal ? 'humano_robo' : 'humano_sozinho';
}

function permutacoes(indices) {
  if (indices.length <= 1) return [indices];
  const resultado = [];
  for (let i = 0; i < indices.length; i++) {
    const resto = [...indices.slice(0, i), ...indices.slice(i + 1)];
    for (const p of permutacoes(resto)) resultado.push([indices[i], ...p]);
  }
  return resultado;
}

// ----------------------------------------------------------------------------
// 1. EXATO (força bruta) — testa todas as ordens x atribuições viáveis.
// ----------------------------------------------------------------------------
function resolverExato(tarefas, ctxOriginal) {
  const inicio = Date.now();
  const ctx = normalizarContexto(ctxOriginal);
  if (tarefas.length === 0) return { algoritmo: 'exato', ordem: [], atribuicoes: {}, custoTotal: 0, tempoCalculoMs: 0 };
  if (tarefas.length > LIMITE_EXATO) {
    return { algoritmo: 'exato', inviavel: true, motivo: `Força bruta desativada acima de ${LIMITE_EXATO} tarefas (cresce em N!×2^N); usa o guloso ou a meta-heurística.`, tempoCalculoMs: Date.now() - inicio };
  }

  const preparadas = prepararTarefas(tarefas, ctx);
  const indices = preparadas.map((_, i) => i);
  const combinacoesAtribuicao = [];
  (function gerar(i, atual) {
    if (i === preparadas.length) { combinacoesAtribuicao.push({ ...atual }); return; }
    const opcoes = preparadas[i].roboViavel ? ['humano_robo', 'humano_sozinho'] : ['humano_sozinho'];
    for (const op of opcoes) { atual[i] = op; gerar(i + 1, atual); }
  })(0, {});

  const cacheBfs = new Map();
  let melhor = null;
  for (const ordem of permutacoes(indices)) {
    for (const atribuicoes of combinacoesAtribuicao) {
      const r = avaliarSequencia(preparadas, ordem, atribuicoes, ctx, cacheBfs);
      if (!melhor || r.custoTotal < melhor.custoTotal) melhor = { ordem: [...ordem], atribuicoes: { ...atribuicoes }, ...r };
    }
  }

  return { algoritmo: 'exato', ...melhor, tempoCalculoMs: Date.now() - inicio };
}

// ----------------------------------------------------------------------------
// 2. GULOSO — para cada passo, escolhe a tarefa pendente mais próxima da
//    posição atual e decide a sua atribuição na hora (sem olhar para trás).
// ----------------------------------------------------------------------------
function resolverGuloso(tarefas, ctxOriginal) {
  const inicio = Date.now();
  const ctx = normalizarContexto(ctxOriginal);
  const { prateleiras, maxX, maxY, deposito, robo, velocidadeHumanoMS } = ctx;
  const ocupadas = new Set(prateleiras.map(p => chave(p.PosX, p.PosY)));
  const preparadas = prepararTarefas(tarefas, ctx);

  const cacheBfs = new Map();
  const restantes = new Set(preparadas.map((_, i) => i));
  const ordem = [];
  const atribuicoes = {};
  let pos = deposito;

  while (restantes.size > 0) {
    let melhorIdx = null, melhorDist = Infinity;
    for (const idx of restantes) {
      const d = distanciaPosicaoAPrateleira(pos, preparadas[idx].tarefa.PosX, preparadas[idx].tarefa.PosY, ocupadas, maxX, maxY, cacheBfs);
      if (d < melhorDist) { melhorDist = d; melhorIdx = idx; }
    }
    const prep = preparadas[melhorIdx];
    const atribuicao = atribuicaoGulosaDeTarefa(prep, robo, velocidadeHumanoMS);
    ordem.push(melhorIdx);
    atribuicoes[melhorIdx] = atribuicao;
    pos = (atribuicao === 'humano_robo') ? prep.nucleo.pontoEncontro : prep.nucleo.deposito;
    restantes.delete(melhorIdx);
  }

  const r = avaliarSequencia(preparadas, ordem, atribuicoes, ctx, cacheBfs);
  return { algoritmo: 'guloso', ordem, atribuicoes, ...r, tempoCalculoMs: Date.now() - inicio };
}

// ----------------------------------------------------------------------------
// 3. META-HEURÍSTICA — recozimento simulado a partir da solução gulosa.
//    Vizinhança: trocar a ordem de duas tarefas, ou inverter a atribuição de
//    uma tarefa (quando o robô é viável para ela).
// ----------------------------------------------------------------------------
function resolverMetaheuristica(tarefas, ctxOriginal, opcoes = {}) {
  const inicio = Date.now();
  const ctx = normalizarContexto(ctxOriginal);
  const iteracoes = opcoes.iteracoes || 800;
  const temperaturaInicial = opcoes.temperaturaInicial || 50;
  const arrefecimento = opcoes.arrefecimento || 0.995;
  const semente = opcoes.semente ?? SEMENTE_PREDEFINIDA;

  const preparadas = prepararTarefas(tarefas, ctx);
  if (preparadas.length === 0) return { algoritmo: 'meta-heuristica', ordem: [], atribuicoes: {}, custoTotal: 0, tempoCalculoMs: Date.now() - inicio };

  const base = resolverGuloso(tarefas, ctx);
  let ordemAtual = [...base.ordem];
  let atribAtual = { ...base.atribuicoes };
  let custoAtual = base.custoTotal;

  let melhorOrdem = [...ordemAtual], melhorAtrib = { ...atribAtual }, melhorCusto = custoAtual;

  let temperatura = temperaturaInicial;
  const random = criarGeradorAleatorio(semente);
  const cacheBfs = new Map();

  for (let it = 0; it < iteracoes && preparadas.length > 1; it++) {
    const novaOrdem = [...ordemAtual];
    const novaAtrib = { ...atribAtual };

    if (random() < 0.5) {
      // Vizinho: troca a posição de duas tarefas na sequência.
      const i = Math.floor(random() * novaOrdem.length);
      let j = Math.floor(random() * novaOrdem.length);
      if (i === j) j = (j + 1) % novaOrdem.length;
      [novaOrdem[i], novaOrdem[j]] = [novaOrdem[j], novaOrdem[i]];
    } else {
      // Vizinho: inverte a atribuição de uma tarefa (só se o robô for viável para ela).
      const idx = novaOrdem[Math.floor(random() * novaOrdem.length)];
      if (preparadas[idx].roboViavel) {
        novaAtrib[idx] = (novaAtrib[idx] === 'humano_robo') ? 'humano_sozinho' : 'humano_robo';
      }
    }

    const r = avaliarSequencia(preparadas, novaOrdem, novaAtrib, ctx, cacheBfs);
    const delta = r.custoTotal - custoAtual;

    if (delta < 0 || random() < Math.exp(-delta / Math.max(temperatura, 1e-6))) {
      ordemAtual = novaOrdem; atribAtual = novaAtrib; custoAtual = r.custoTotal;
      if (custoAtual < melhorCusto) { melhorOrdem = [...ordemAtual]; melhorAtrib = { ...atribAtual }; melhorCusto = custoAtual; }
    }

    temperatura *= arrefecimento;
  }

  const final = avaliarSequencia(preparadas, melhorOrdem, melhorAtrib, ctx, cacheBfs);
  return { algoritmo: 'meta-heuristica', ordem: melhorOrdem, atribuicoes: melhorAtrib, ...final, tempoCalculoMs: Date.now() - inicio };
}

// Corre os três e devolve os resultados lado a lado, para comparação
// (tempo de cálculo vs. qualidade da solução) — pedido explícito do relatório.
function compararAlgoritmos(tarefas, ctx) {
  const guloso = resolverGuloso(tarefas, ctx);
  const metaheuristica = resolverMetaheuristica(tarefas, ctx);
  const exato = resolverExato(tarefas, ctx);
  return { exato, guloso, metaheuristica };
}

module.exports = {
  resolverExato, resolverGuloso, resolverMetaheuristica, compararAlgoritmos,
  prepararTarefas, avaliarSequencia, LIMITE_EXATO, SEMENTE_PREDEFINIDA,
};
