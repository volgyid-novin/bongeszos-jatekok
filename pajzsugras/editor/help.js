// PAJZSUGRÁS map editor: the list of controls, one source for the H help overlay (editor/panel.js) and the IRÁNYÍTÁS screen (ui.js).
// [keys, what it does]. Pure data.
export const EDITOR_HELP = [
  ['Jobb gomb nyomva', 'körbenézés (az egér befogódik; ha a böngésző nem engedi, húzással is megy)'],
  ['W A S D', 'repülés'], ['Szóköz / E', 'fel'], ['Q / C', 'le'], ['Shift', '3× gyorsabb repülés'], ['Görgő', 'repülési sebesség'], ['Shift + görgő', 'lerakás előtt: emelés / süllyesztés (a levegőbe is rakhatsz); kijelölésnél: a kijelölt elem fel / le'],
  ['Bal gomb', 'lerak (eszközzel) vagy kijelöl; a kijelölt elemet húzva mozgatod'],
  ['1 – 0', 'eszközök: padló, fal, kiugrófal, rámpa, oszlop, láva, lézer, ugrópárna, ellenőrzőpont, cél'],
  ['Palettán kattintva', 'a gyorsbillentyű nélküli eszközök: „semmi” zóna, rajtpont, fény, díszek (láda, oszlop, szikla, kristály, jelzőfény, boltív)'],
  ['V / Esc', 'kijelölő eszköz (Esc: előbb a súgó, a függő párna-cél, az eszköz, aztán a kijelölés szűnik)'],
  ['K', 'a rajtpont oda, ahová célzol, a kamera irányával'],
  ['Nyilak', 'a kijelölt elem mozgatása (0,5 m, a kamerához képest)'], ['PgUp / PgDn', 'mozgatás fel / le'],
  ['Shift + nyilak', 'átméretezés (Shift + PgUp / PgDn: magasság, a párna csúcsa, a fény hatótávja)'],
  ['R', 'forgatás 90°-kal (kijelölés nélkül az új elem forgatása)'], ['Ctrl + D', 'másolás'], ['Del / Backspace', 'törlés'],
  ['Ctrl + Z', 'visszavonás'], ['Ctrl + Y / Ctrl + Shift + Z', 'újra'],
  ['Ctrl + S', 'mentés most (magától is ment: 1,5 mp-cel a módosítás után, próba előtt és kilépéskor)'],
  ['Exportálás gomb', 'a pálya letöltése .json fájlként (visszatölthető a szerkesztő főoldalán: Importálás)'],
  ['F', 'a kijelölésre ránéz'], ['G', 'rács 0,5 m / 0,1 m'],
  ['Ugrópárna eszköz', '1. kattintás: a párna, 2. kattintás: a cél'],
  ['T vagy F2', 'próba a kamerától (gyakorló: a cél az ellenőrzőpontok nélkül is számít)'], ['Enter', 'próba a rajttól (teljes szabályok)'],
  ['F2 / Esc próba közben', 'vissza a szerkesztőbe, ugyanoda'], ['Tab', 'panelek elrejtése'], ['H', 'ez a súgó'],
];
