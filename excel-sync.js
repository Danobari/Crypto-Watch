// Mantiene Tracker.xlsx sincronizado con data/positions.json y los precios
// en vivo de Binance. La idea es que Tracker.xlsx deje de llenarse a mano:
// este módulo escribe Cantidad, Precio_Entrada, Precio_Actual y los
// niveles/próxima acción/bloque cada vez que se corre, y Excel recalcula
// solo las columnas que siguen siendo fórmulas (%_Cambio, Valor_Actual)
// en cuanto Daniel abra el archivo.
//
// No toca la hoja "Reglas del sistema" ni la columna "Notas del Mercado"
// (M) — esas son de Daniel.

import ExcelJS from 'exceljs';
import path from 'path';
import { changePctFromEntry, nextActionText, pctSold } from './ladder.js';

const TRACKER_PATH = path.resolve('./Tracker.xlsx');

const BLOCK_LABELS = { core: 'Core', rotation: 'Rotación', experimental: 'Experimental' };

const COLS = {
  activo: 'A',
  cantidad: 'B',
  entrada: 'C',
  actual: 'D',
  cambio: 'E', // fórmula existente, no se toca
  valor: 'F', // fórmula existente, no se toca
  nivel1: 'G',
  nivel2: 'H',
  nivel3: 'I',
  vendido: 'J',
  accion: 'K',
  bloque: 'L',
  notas: 'M', // de Daniel, no se toca
};

function findWorksheet(workbook) {
  return workbook.getWorksheet('Hoja 1') || workbook.worksheets[0];
}

function findRowForCoin(ws, coin) {
  let found = null;
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // encabezado
    const activo = row.getCell(COLS.activo).value;
    if (activo && String(activo).toUpperCase() === coin.toUpperCase()) {
      found = rowNumber;
    }
  });
  return found;
}

// ws.lastRow de ExcelJS puede incluir filas vacías que solo tienen estilo
// (sin ningún dato), así que para saber dónde agregar una posición nueva
// contamos la última fila que de verdad tiene algo en "Activo", no la
// última fila que existe como objeto en la hoja.
function nextEmptyRow(ws) {
  let last = 1;
  ws.eachRow((row, rowNumber) => {
    if (row.getCell(COLS.activo).value) last = rowNumber;
  });
  return last + 1;
}

// El archivo original guarda G/H/I (y a veces E/F) como "fórmulas
// compartidas": una sola fórmula maestra en la primera fila y el resto son
// clones que apuntan a esa maestra. Si reescribimos una sola celda de ese
// grupo con un valor plano o una fórmula distinta, ExcelJS puede corromper
// o directamente rechazar las demás filas del grupo ("Shared Formula
// master must exist..."). Para evitar eso, antes de escribir nada
// "aplanamos" toda la columna a valores planos (usando el último resultado
// calculado que Excel guardó en el archivo), fila por fila. Después de
// esto ya no quedan fórmulas compartidas de las que preocuparse.
function flattenFormulaColumn(ws, colLetter) {
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cell = row.getCell(colLetter);
    const v = cell.value;
    // La celda "maestra" de una fórmula compartida trae { formula, result, ... },
    // y cada "clon" trae { result, sharedFormula: '<celda maestra>' } sin
    // `formula` propio — hay que aplanar ambos casos, si no, al tocar la
    // maestra los clones quedan huérfanos y ExcelJS rechaza el archivo entero.
    if (v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)) {
      cell.value = 'result' in v ? v.result : null;
    }
  });
}

export async function syncTrackerExcel(positions, tickers, balances, symbolFor) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(TRACKER_PATH);
  const ws = findWorksheet(workbook);
  if (!ws) throw new Error('No se encontró la hoja de la cartera en Tracker.xlsx');

  [COLS.nivel1, COLS.nivel2, COLS.nivel3].forEach((col) => flattenFormulaColumn(ws, col));

  for (const position of positions) {
    const ticker = tickers[symbolFor(position.coin)];
    const currentPrice = ticker ? ticker.price : null;
    const holding = balances.find((b) => b.asset === position.coin.toUpperCase());
    const holdingAmount = holding ? holding.free + holding.locked : null;
    const changePct = currentPrice !== null ? changePctFromEntry(position.entryPrice, currentPrice) : null;

    let rowNumber = findRowForCoin(ws, position.coin);
    const isNewRow = !rowNumber;
    if (isNewRow) {
      rowNumber = nextEmptyRow(ws);
      const row = ws.getRow(rowNumber);
      row.getCell(COLS.activo).value = position.coin;
    }

    const row = ws.getRow(rowNumber);
    if (holdingAmount !== null) row.getCell(COLS.cantidad).value = holdingAmount;
    row.getCell(COLS.entrada).value = position.entryPrice;
    if (currentPrice !== null) row.getCell(COLS.actual).value = currentPrice;

    // Para una fila nueva, %_Cambio y Valor_Actual también se escriben como
    // valores planos (no fórmulas) para no arriesgarnos a que ExcelJS los
    // intente agrupar con las fórmulas compartidas de las filas viejas.
    if (isNewRow) {
      row.getCell(COLS.cambio).value = currentPrice !== null ? changePct / 100 : null;
      row.getCell(COLS.valor).value = holdingAmount !== null && currentPrice !== null ? holdingAmount * currentPrice : null;
    }

    // Niveles como valores calculados (no fórmulas): el archivo original
    // tenía la misma fórmula "compartida" (=C*1.4, *1.8, *2.2) en toda la
    // columna para todos los activos. Como ahora cada bloque tiene su
    // propio % (Core, Rotación, Experimental ya no son iguales), escribir
    // una fórmula distinta por fila rompe esa fórmula compartida y termina
    // alterando filas que ni siquiera tocamos. Un valor plano evita ese lío
    // — Daniel de todas formas no edita el precio de entrada a mano en
    // Excel, este script lo sincroniza desde positions.json cada vez.
    const nivelCols = [COLS.nivel1, COLS.nivel2, COLS.nivel3];
    position.levels.slice(0, 3).forEach((level, i) => {
      const multiplier = 1 + level.pct / 100;
      row.getCell(nivelCols[i]).value = position.entryPrice * multiplier;
    });

    row.getCell(COLS.vendido).value = pctSold(position) / 100; // como fracción, formatea como % en Excel si quieres
    row.getCell(COLS.accion).value = currentPrice !== null ? nextActionText(position, changePct) : 'Sin precio de referencia';
    row.getCell(COLS.bloque).value = BLOCK_LABELS[position.block] || position.block;

    row.commit();
  }

  // Encabezados de los niveles ya no son un % fijo igual para todos los
  // bloques — se deja el nombre genérico para no mentir sobre el %.
  ws.getCell('G1').value = 'Nivel_1';
  ws.getCell('H1').value = 'Nivel_2';
  ws.getCell('I1').value = 'Nivel_3';
  ws.getCell('J1').value = '%_Ya_Vendido';
  ws.getCell('K1').value = 'Proxima_Accion';
  ws.getCell('L1').value = 'Bloque';

  await workbook.xlsx.writeFile(TRACKER_PATH);
}
