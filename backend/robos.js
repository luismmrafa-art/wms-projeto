// ============================================================================
// robos.js — Catálogo de robôs e recomendação (comportamento de SAD)
//
// Responde à crítica "ignoraste as especificações e os modelos de navegação
// dos robôs, e assumiste que humano e robô têm a mesma velocidade e destreza".
//
// O catálogo (tabela TiposRobo) modela 4 tipos distintos, cada um com
// capacidade de carga, velocidade, tipo de navegação e a largura mínima de
// corredor que o robô precisa para circular. Dado o layout de um armazém
// (a largura do seu corredor) e as tarefas pendentes, recomendarRobo filtra
// os tipos que cabem fisicamente e pontua os restantes, comportando-se como
// um Sistema de Apoio à Decisão: não impõe um único robô, propõe o mais
// adequado a CADA armazém.
// ============================================================================

const VELOCIDADE_HUMANO_MS = 1.0; // referência: passo humano médio a andar em armazém

async function listarTiposRobo(pool) {
  const [tipos] = await pool.query('SELECT * FROM TiposRobo ORDER BY CapacidadeCargaKg');
  return tipos;
}

// Estatísticas de carga das tarefas pendentes, usadas para dimensionar o robô.
function estatisticasTarefas(tarefas) {
  if (!tarefas || tarefas.length === 0) {
    return { pesoMaximoKg: 0, pesoMedioKg: 0, algumaFragil: false };
  }
  const pesos = tarefas.map(t => Number(t.PesoKg) || 0);
  const pesoMaximoKg = Math.max(...pesos);
  const pesoMedioKg = pesos.reduce((a, b) => a + b, 0) / pesos.length;
  const algumaFragil = tarefas.some(t => !!t.Fragil);
  return { pesoMaximoKg, pesoMedioKg, algumaFragil };
}

// Recomenda o(s) tipo(s) de robô mais adequados a um armazém concreto.
// larguraCorredorM: largura física do corredor principal deste armazém (m).
// tarefas: lista de tarefas pendentes (cada uma com PesoKg, Fragil) — usadas
// para dimensionar a capacidade necessária.
function recomendarRobo({ tiposRobo, larguraCorredorM, tarefas }) {
  const stats = estatisticasTarefas(tarefas);
  const velocidadeMaxima = Math.max(...tiposRobo.map(r => Number(r.VelocidadeMS)));

  const avaliados = tiposRobo.map(robo => {
    const capacidade = Number(robo.CapacidadeCargaKg);
    const largura = Number(robo.LarguraMinCorredorM);
    const velocidade = Number(robo.VelocidadeMS);

    const cabeNoCorredor = largura <= larguraCorredorM;
    const aguentaOMaisPesado = capacidade >= stats.pesoMaximoKg;
    const viavel = cabeNoCorredor && aguentaOMaisPesado;

    let motivo, pontuacao = 0;
    if (!cabeNoCorredor) {
      motivo = `Precisa de corredor com ${largura.toFixed(2)} m; este armazém tem ${larguraCorredorM.toFixed(2)} m.`;
    } else if (!aguentaOMaisPesado) {
      motivo = `Capacidade (${capacidade} kg) insuficiente para o artigo mais pesado pendente (${stats.pesoMaximoKg.toFixed(1)} kg).`;
    } else {
      // Desperdício de capacidade: robô sobredimensionado para a carga típica
      // (mais caro/lento que o necessário). Normalizado a [0,1].
      const desperdicio = Math.max(0, capacidade - stats.pesoMedioKg) / capacidade;
      const aproveitamentoCapacidade = 1 - desperdicio;
      const aproveitamentoVelocidade = velocidade / velocidadeMaxima;
      // Pondera mais o ajuste de capacidade (evita sobre-investir num robô
      // grande para cargas leves) do que a velocidade pura.
      pontuacao = 0.6 * aproveitamentoCapacidade + 0.4 * aproveitamentoVelocidade;
      motivo = `Compatível: cabe no corredor (${largura.toFixed(2)} m) e aguenta o mais pesado (${stats.pesoMaximoKg.toFixed(1)} kg).`;
    }

    return { ...robo, viavel, pontuacao: Number(pontuacao.toFixed(3)), motivo };
  });

  avaliados.sort((a, b) => (b.viavel - a.viavel) || (b.pontuacao - a.pontuacao));

  return {
    recomendado: avaliados.find(r => r.viavel) || null,
    alternativas: avaliados,
    contexto: { larguraCorredorM, ...stats },
  };
}

module.exports = { listarTiposRobo, recomendarRobo, estatisticasTarefas, VELOCIDADE_HUMANO_MS };
