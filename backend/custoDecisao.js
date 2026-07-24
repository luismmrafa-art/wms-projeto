// ============================================================================
// custoDecisao.js — Decisão multicritério humano vs. robô
//
// Responde à crítica central: "a atribuição não pode ser só pela distância" e
// "não se pode assumir que humano e robô têm a mesma velocidade e destreza".
//
// Para cada recolha, compara duas opções e escolhe a de menor custo:
//   (a) humano+robô — o operador leva a carga só até ao ponto de encontro
//       (BFS calcula a distância) e o robô faz o resto;
//   (b) humano sozinho — o operador leva a carga até ao depósito, sem robô
//       (obrigatório se o artigo exceder a capacidade do robô).
//
// O custo combina tempo (cada agente com a sua própria velocidade) e
// penalizações: um artigo frágil entregue ao robô no ponto de encontro tem
// risco de manuseamento acrescido; um artigo demasiado pesado para o robô
// torna essa opção inviável, não apenas pior.
// ============================================================================

const TAMANHO_CELULA_M = 1.0;        // 1 célula da grelha ≈ 1 metro (assunção documentada no relatório)
const FATOR_RISCO_FRAGIL = 0.35;     // penalização de tempo (35%) por entregar um artigo frágil ao robô
const PESO_ESFORCO_OPERADOR = 0.7;   // no custo total, o esforço do operador pesa mais do que o tempo do robô
const PESO_TEMPO_ROBO = 0.3;

function tempoEmSegundos(distanciaCelulas, velocidadeMS) {
  return (distanciaCelulas * TAMANHO_CELULA_M) / velocidadeMS;
}

// Um artigo só pode ir de robô se o robô existir e aguentar o peso total da
// tarefa — peso unitário × quantidade, já que o operador recolhe e entrega
// todas as unidades da tarefa de uma vez, não uma a uma.
// Usado pelos algoritmos de planeamento (algoritmos.js) para saber que
// atribuições são sequer possíveis de testar/trocar.
function pesoTotalTarefa(artigo) {
  const pesoUnitario = Number(artigo?.PesoKg ?? 1);
  const quantidade = Number(artigo?.Quantidade ?? 1);
  return pesoUnitario * quantidade;
}

function opcaoRoboViavel(robo, artigo) {
  if (!robo) return false;
  return pesoTotalTarefa(artigo) <= Number(robo.CapacidadeCargaKg);
}

// Custo de UMA tarefa sob uma atribuição já decidida (não escolhe — só mede).
// Reutilizado tanto pela decisão automática (avaliarTarefa) como pelos três
// algoritmos, que exploram as duas atribuições como alternativas possíveis.
function custoTarefaComAtribuicao({
  atribuicao,
  distanciaOperadorAteEncontro,
  distanciaRoboAteEncontro,
  distanciaOperadorSemRobo,
  velocidadeHumanoMS,
  robo,
  artigo,
}) {
  const fragil = !!artigo?.Fragil;
  const alertas = [];

  if (atribuicao === 'humano_sozinho' || !robo) {
    const tempoOperadorH = tempoEmSegundos(distanciaOperadorSemRobo, velocidadeHumanoMS);
    // Mesma ponderação da opção com robô (linha 63), para as duas ficarem na
    // mesma escala — sem isto, esta opção fica artificialmente mais cara
    // (÷0,7) e a decisão inclina-se para o robô mesmo quando não compensa.
    const custoTotal = PESO_ESFORCO_OPERADOR * tempoOperadorH;
    return { atribuicao: 'humano_sozinho', tempoOperadorH, tempoRoboH: 0, custoTotal, alertas };
  }

  const tempoOperadorH = tempoEmSegundos(distanciaOperadorAteEncontro, velocidadeHumanoMS);
  let tempoRoboH = tempoEmSegundos(distanciaRoboAteEncontro, Number(robo.VelocidadeMS));
  if (fragil) {
    tempoRoboH *= (1 + FATOR_RISCO_FRAGIL);
    alertas.push(`Artigo frágil: penalização de ${(FATOR_RISCO_FRAGIL * 100).toFixed(0)}% no tempo do robô.`);
  }
  const custoTotal = PESO_ESFORCO_OPERADOR * tempoOperadorH + PESO_TEMPO_ROBO * tempoRoboH;
  return { atribuicao: 'humano_robo', tempoOperadorH, tempoRoboH, custoTotal, alertas };
}

// Avalia uma única tarefa (recolha) e decide a melhor atribuição (a decisão
// "gulosa" de referência: olha só para esta tarefa, sem considerar a sequência).
function avaliarTarefa({
  distanciaOperadorAteEncontro,
  distanciaRoboAteEncontro,
  distanciaOperadorSemRobo,
  velocidadeHumanoMS,
  robo,
  artigo,
}) {
  const alertas = [];
  const semRobo = custoTarefaComAtribuicao({
    atribuicao: 'humano_sozinho', distanciaOperadorAteEncontro, distanciaRoboAteEncontro,
    distanciaOperadorSemRobo, velocidadeHumanoMS, robo, artigo,
  });

  if (!opcaoRoboViavel(robo, artigo)) {
    if (robo) {
      const quantidade = Number(artigo?.Quantidade ?? 1);
      const descricaoPeso = quantidade > 1
        ? `${pesoTotalTarefa(artigo)} kg (${artigo?.PesoKg ?? '?'} kg × ${quantidade} unidades)`
        : `${artigo?.PesoKg ?? '?'} kg`;
      alertas.push(`Artigo (${descricaoPeso}) excede a capacidade do robô "${robo.Nome}" (${robo.CapacidadeCargaKg} kg).`);
    }
    return { ...semRobo, motivo: robo ? 'Peso acima da capacidade do robô — opção robô inviável, não apenas pior.' : 'Nenhum robô compatível com este armazém.', alertas };
  }

  const comRobo = custoTarefaComAtribuicao({
    atribuicao: 'humano_robo', distanciaOperadorAteEncontro, distanciaRoboAteEncontro,
    distanciaOperadorSemRobo, velocidadeHumanoMS, robo, artigo,
  });

  if (comRobo.custoTotal <= semRobo.custoTotal) {
    return { ...comRobo, motivo: 'Menor custo combinado (esforço do operador + tempo do robô).', alertas: [...alertas, ...comRobo.alertas] };
  }
  return { ...semRobo, motivo: 'O desvio ao ponto de encontro custaria mais do que seguir sozinho até ao depósito.', alertas };
}

module.exports = {
  avaliarTarefa,
  custoTarefaComAtribuicao,
  opcaoRoboViavel,
  pesoTotalTarefa,
  tempoEmSegundos,
  TAMANHO_CELULA_M,
  FATOR_RISCO_FRAGIL,
  PESO_ESFORCO_OPERADOR,
  PESO_TEMPO_ROBO,
};
