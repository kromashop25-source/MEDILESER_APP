# templates_inline.py
# HTML embebido usado como fallback por la app cuando no encuentra app/templates/index.html

INDEX_HTML = r"""
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <title>Consolidación de Bases Originales Correlativos</title>
  <style>
    body { font-family: Arial, sans-serif; }
    .file-actions { margin-top:.5rem; display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
    .file-list { list-style:none; padding-left:0; margin-top:.5rem; }
    .file-list li { display:flex; align-items:center; gap:.5rem; margin-bottom:.25rem; }
    .hidden { display:none; }
    .status-message { margin-top:.5rem; display:inline-block; }
    .status-message.error { color:#b00020; }
    button { cursor:pointer; }
    .drop-zone { border:2px dashed #888; border-radius:8px; padding:1rem; margin-top:.5rem; text-align:center; transition:border-color .2s, background-color .2s; }
    .drop-zone:focus { outline:2px solid #3b82f6; outline-offset:2px; }
    .drop-zone--active { border-color:#2563eb; background-color:rgba(37,99,235,.08); }
    .drop-zone__hint { font-size:.9rem; color:#444; }
    .note { font-size:.85rem; color:#666; margin-top:.25rem; }
    .visually-hidden { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
    .file-status { display:block; margin-top:.35rem; font-size:.95rem; color:#222; }
    .status-inline { font-size:.9rem; color:#444; }
    .status-inline.error { color:#b00020; }
  </style>
</head>
<body>
  <h1>Consolidación de bases originales Correlativos</h1>

  <form action="/merge" method="post" enctype="multipart/form-data" id="merge-form">
    <!-- Maestro -->
    <label for="master-input">Archivo maestro (.xlsx):</label><br />
    <input type="file" id="master-input" name="master" accept=".xlsx" required class="hidden" />
    <div id="master-dropzone" class="drop-zone" role="button" tabindex="0" aria-describedby="master-drop-hint">
      <p><strong>Suelta aquí el maestro (.xlsx)</strong></p>
      <p class="drop-zone__hint">O usa el botón "Elegir archivo".</p>
      <p class="note">Tip: arrastra desde el Explorador de archivos (no desde el panel de descargas del navegador).</p>
      <p class="note" id="master-limit-hint"></p>
    </div>
    <span id="master-drop-hint" class="visually-hidden">Presiona Enter o Espacio para abrir el selector de archivos maestro.</span>
    <div class="file-actions">
  <button type="button" id="master-select">Elegir archivo</button>
  <button type="button" id="master-clear" class="hidden">Eliminar</button>
  <span id="master-drop-status" class="status-inline hidden" role="status" aria-live="polite"></span>
</div>
<div id="master-status" class="file-status">No se eligió ningún archivo</div>
    <span id="master-drop-status" class="status-inline hidden" role="status" aria-live="polite"></span>

    <br />

    <!-- Técnicos -->
    <label for="technicians-input">Archivos técnicos (.xlsx):</label><br />
    <input type="file" id="technicians-input" name="technicians" accept=".xlsx" multiple required class="hidden" />
    <div id="technicians-dropzone" class="drop-zone" role="button" tabindex="0" aria-describedby="technicians-drop-hint">
      <p><strong>Suelta aquí uno o varios técnicos (.xlsx)</strong></p>
      <p class="drop-zone__hint">También puedes usar el botón "Agregar archivos".</p>
      <p class="note">Tip: arrastra desde el Explorador de archivos (no desde el panel de descargas del navegador).</p>
      <p class="note" id="technicians-limit-hint"></p>
    </div>
    <span id="technicians-drop-hint" class="visually-hidden">Presiona Enter o Espacio para abrir el selector de archivos técnicos.</span>
    <div class="file-actions">
      <button type="button" id="technicians-add">Agregar archivos</button>
      <button type="button" id="technicians-clear" disabled>Eliminar todos</button>
      <span id="technicians-status" class="status-inline">No se eligió ningún archivo</span>
      <span id="technicians-drop-status" class="status-inline hidden" role="status" aria-live="polite"></span>
    </div>
    <ul id="technicians-list" class="file-list"></ul>

    <br />

    <!-- Acciones -->
    <div class="file-actions">
      <button type="submit" id="merge-submit" disabled>Consolidar</button>
      <button type="button" id="merge-cancel" class="hidden" disabled>Cancelar</button>
      <!-- SOLO resultados/validaciones -->
      <div id="status" class="status-message hidden" role="status" aria-live="polite" tabindex="-1"></div>
    </div>
  </form>

  <script>
    document.addEventListener('DOMContentLoaded', function () {
      const uploadLimits = { maxFileMb: 25, maxTechFiles: 50 };
      let lastValidationReason = null;

      const masterLimitHint = document.getElementById('master-limit-hint');
      const techniciansLimitHint = document.getElementById('technicians-limit-hint');

      function renderLimitHints(){
        const sizeText = `Limite de ${uploadLimits.maxFileMb}MB por archivo.`;
        if (masterLimitHint) masterLimitHint.textContent = sizeText;
        if (techniciansLimitHint) techniciansLimitHint.textContent = `${sizeText} Maximo ${uploadLimits.maxTechFiles} tecnicos.`;
      }

      async function fetchUploadLimits(){
        try {
          const resp = await fetch('/config/upload-limits');
          if (resp.ok){
            const data = await resp.json();
            if (data && typeof data.max_file_mb === 'number') uploadLimits.maxFileMb = data.max_file_mb;
            if (data && typeof data.max_tech_files === 'number') uploadLimits.maxTechFiles = data.max_tech_files;
          }
        } catch (_) { /* no-op si falla */ }
        renderLimitHints();
        updateSubmitState();
      }

      renderLimitHints();
      fetchUploadLimits();

      // Evita que el navegador navegue/descargue al soltar fuera de zonas
      ['dragover', 'drop'].forEach(function (evt) {
        window.addEventListener(evt, function (e) { e.preventDefault(); });
      });

      // --- Elements
      const masterInput = document.getElementById('master-input');
      const masterSelectButton = document.getElementById('master-select');
      const masterClearButton = document.getElementById('master-clear');
      const masterStatus = document.getElementById('master-status');
      const masterDropZone = document.getElementById('master-dropzone');
      const masterDropStatus = document.getElementById('master-drop-status');

      const techniciansInput = document.getElementById('technicians-input');
      const techniciansAddButton = document.getElementById('technicians-add');
      const techniciansClearButton = document.getElementById('technicians-clear');
      const techniciansList = document.getElementById('technicians-list');
      const techniciansStatus = document.getElementById('technicians-status');
      const techniciansDropZone = document.getElementById('technicians-dropzone');
      const techniciansDropStatus = document.getElementById('technicians-drop-status');

      const mergeForm = document.getElementById('merge-form');
      const mergeSubmitButton = document.getElementById('merge-submit');
      const mergeCancelButton = document.getElementById('merge-cancel');
      const statusMessage = document.getElementById('status');

      // --- State (no dependemos de input.files)
      let masterFile = null;
      let selectedTechnicians = [];
      let isSubmitting = false;
      let showValidationHints = false;
      let currentAbortController = null;

      // --- Utils
      function isXlsx(file){ return !!(file && file.name && file.name.toLowerCase().endsWith('.xlsx')); }
      function dedupeByName(files){
        const map = new Map();
        files.forEach(f => { if (f && f.name) { const k = f.name.toLowerCase(); if (!map.has(k)) map.set(k, f); } });
        return Array.from(map.values());
      }
      function setStatus(msg, isError){
        if (!msg){ statusMessage.textContent=''; statusMessage.classList.add('hidden'); statusMessage.classList.remove('error'); return; }
        statusMessage.textContent = msg;
        statusMessage.classList.remove('hidden');
        statusMessage.classList.toggle('error', !!isError);
        requestAnimationFrame(()=>{ try{ statusMessage.focus(); }catch(_){} });
      }
      function showDropStatus(kind, msg, type){
        const target = (kind === 'master') ? masterDropStatus : techniciansDropStatus;
        if (!msg){ target.textContent=''; target.classList.add('hidden'); target.classList.remove('error'); return; }
        target.textContent = msg;
        target.classList.remove('hidden');
        target.classList.toggle('error', type === 'error');
      }

      function computeValidationMessage(){
        const state = { message: '', alwaysShow: false, reason: null };
        const maxMb = Number(uploadLimits.maxFileMb) || 25;
        const limitBytes = maxMb * 1024 * 1024;

        if (!masterFile){ state.message = 'Selecciona un archivo maestro (.xlsx).'; return state; }
        if (!isXlsx(masterFile)){ state.message = 'El archivo maestro debe tener extension .xlsx.'; state.reason = 'invalid_master_ext'; return state; }
        if (selectedTechnicians.length === 0){ state.message = 'Selecciona al menos un archivo tecnico (.xlsx).'; return state; }

        const invalid = selectedTechnicians.find(f => !isXlsx(f));
        if (invalid){ state.message = `"${invalid.name}" no es un .xlsx valido.`; state.reason = 'invalid_tech_ext'; return state; }

        if (selectedTechnicians.length > uploadLimits.maxTechFiles){
          state.message = `Demasiados tecnicos, max ${uploadLimits.maxTechFiles}.`;
          state.alwaysShow = true;
          state.reason = 'too_many_files';
          return state;
        }

        if (masterFile && masterFile.size && masterFile.size > limitBytes){
          state.message = `El maestro supera ${maxMb}MB.`;
          state.alwaysShow = true;
          state.reason = 'master_too_big';
          return state;
        }

        const oversize = selectedTechnicians.find(f => f && f.size && f.size > limitBytes);
        if (oversize){
          state.message = `El archivo "${oversize.name}" supera ${maxMb}MB.`;
          state.alwaysShow = true;
          state.reason = 'tech_too_big';
          return state;
        }
        return state;
     }
      function updateSubmitState(){
        const state = computeValidationMessage();
        const ready = (state.message === '');

        if (!isSubmitting){
          if (state.message && (state.alwaysShow || showValidationHints)){
            setStatus(state.message, true);
          } else if (!state.message && statusMessage.classList.contains('error')){
            setStatus('', false);
          }
        }

        if (state.reason !== lastValidationReason){
          if (state.reason === 'too_many_files' || state.reason === 'tech_too_big'){
            showDropStatus('technicians', state.message, 'error');
          } else if ((lastValidationReason === 'too_many_files' || lastValidationReason === 'tech_too_big') && techniciansDropStatus && techniciansDropStatus.classList.contains('error')){
            showDropStatus('technicians', '');
          }

          if (state.reason === 'master_too_big'){
            showDropStatus('master', state.message, 'error');
          } else if (lastValidationReason === 'master_too_big' && masterDropStatus && masterDropStatus.classList.contains('error')){
            showDropStatus('master', '');
          }
          lastValidationReason = state.reason;
        }

        mergeSubmitButton.disabled = !ready || isSubmitting;
        mergeCancelButton.disabled = !isSubmitting;
        mergeCancelButton.classList.toggle('hidden', !isSubmitting);
      }

      // Opcional: intentar reflejar archivos en el input si el navegador lo permite
      function trySyncInputFiles(input, files){
        try{
          if (!('DataTransfer' in window)) return;
          const dt = new DataTransfer();
          files.forEach(f => dt.items.add(f));
          input.files = dt.files;
        }catch(_){ /* no-op si no soporta */ }
      }

      // --- Maestro
      function renderMaster(){
        if (masterFile){ masterStatus.textContent = masterFile.name; masterClearButton.classList.remove('hidden'); }
        else { masterStatus.textContent = 'No se eligió ningún archivo'; masterClearButton.classList.add('hidden'); }
        updateSubmitState();
      }
      masterSelectButton.addEventListener('click', ()=> masterInput.click());
      masterInput.addEventListener('change', ()=>{
        masterFile = (masterInput.files && masterInput.files[0]) ? masterInput.files[0] : null;
        renderMaster();
      });
      masterClearButton.addEventListener('click', ()=>{ masterFile=null; try{ masterInput.value=''; }catch(_){ } renderMaster(); showDropStatus('master',''); });

      // --- Técnicos
      function renderTechnicians(){
        techniciansList.innerHTML = '';
        if (selectedTechnicians.length === 0){
          techniciansStatus.textContent = 'No se eligió ningún archivo';
          techniciansClearButton.disabled = true;
          updateSubmitState();
          return;
        }
        techniciansStatus.textContent = (selectedTechnicians.length === 1)
          ? selectedTechnicians[0].name
          : (selectedTechnicians.length + ' archivo(s) seleccionado(s)');
        techniciansClearButton.disabled = false;

        selectedTechnicians.forEach((file, idx)=>{
          const li = document.createElement('li');
          const name = document.createElement('span'); name.textContent = file.name;
          const rm = document.createElement('button'); rm.type='button'; rm.textContent='Eliminar';
          rm.addEventListener('click', ()=>{
            selectedTechnicians.splice(idx,1);
            trySyncInputFiles(techniciansInput, selectedTechnicians);
            renderTechnicians();
            if (selectedTechnicians.length===0) showDropStatus('technicians','');
          });
          li.appendChild(name); li.appendChild(rm);
          techniciansList.appendChild(li);
        });
        updateSubmitState();
      }
      techniciansAddButton.addEventListener('click', ()=> techniciansInput.click());
      techniciansInput.addEventListener('change', (e)=>{
        const newFiles = Array.prototype.slice.call(e.target.files || []);
        if (!newFiles.length){ updateSubmitState(); return; }

        const valid = newFiles.filter(isXlsx);
        const invalidCount = newFiles.length - valid.length;
        if (invalidCount>0) showDropStatus('technicians', `Se ignoraron ${invalidCount} archivo(s) sin extensión .xlsx.`, 'error');
        else showDropStatus('technicians','');

        if (!valid.length){ try{ techniciansInput.value=''; }catch(_){ } updateSubmitState(); return; }

        const before = selectedTechnicians.length;
        selectedTechnicians = dedupeByName(selectedTechnicians.concat(valid));
        const added = selectedTechnicians.length - before;
        showDropStatus('technicians', added ? `Se agregaron ${added} archivo(s) de técnicos.` : 'Los archivos ya estaban en la lista.', 'info');

        trySyncInputFiles(techniciansInput, selectedTechnicians); // opcional
        renderTechnicians();       // <— esto actualiza la UL y habilita "Eliminar todos"
        });
      techniciansClearButton.addEventListener('click', ()=>{
        selectedTechnicians = [];
        trySyncInputFiles(techniciansInput, selectedTechnicians);
        renderTechnicians();
        showDropStatus('technicians','');
      });

      // --- Drag & Drop
      function wireDropZone(element, onFiles, kind){
        if (!element) return;
        function prevent(e){ e.preventDefault(); e.stopPropagation(); }
        ['dragenter','dragover'].forEach(evt=>{
          element.addEventListener(evt, (e)=>{
            prevent(e);
            element.classList.add('drop-zone--active');
            if (e.dataTransfer) e.dataTransfer.dropEffect='copy';
          });
        });
        ['dragleave','dragend'].forEach(evt=>{
          element.addEventListener(evt, (e)=>{
            prevent(e);
            element.classList.remove('drop-zone--active');
          });
        });
        element.addEventListener('drop', (e)=>{
          prevent(e);
          element.classList.remove('drop-zone--active');
          const dt = e.dataTransfer || {};
          const files = Array.prototype.slice.call(dt.files || []);
          if (!files.length){
            const hasStrings = dt.items && Array.prototype.some.call(dt.items, it=>it.kind==='string');
            if (hasStrings){
              showDropStatus(kind, 'No se puede arrastrar desde el panel de descargas del navegador. Usa el Explorador de archivos o el botón.', 'error');
            }
            return;
          }
          onFiles(files);
        });
        element.addEventListener('click', ()=> (kind==='master'? masterInput : techniciansInput).click());
        element.addEventListener('keydown', (e)=>{ if (e.key==='Enter'||e.key===' ') { e.preventDefault(); element.click(); } });
      }

      wireDropZone(masterDropZone, function(files){
        const valid = files.filter(isXlsx);
        if (!valid.length){ showDropStatus('master','Solo se permiten archivos .xlsx para el maestro.','error'); return; }
        if (valid.length>1) showDropStatus('master','Se tomó solo el primer archivo para el maestro.','info'); else showDropStatus('master','');
        masterFile = valid[0];
        trySyncInputFiles(masterInput, masterFile ? [masterFile] : []);
        renderMaster();
      }, 'master');

      wireDropZone(techniciansDropZone, function(files){
        const validTechs = files.filter(isXlsx);
        const invalidCount = files.length - validTechs.length;
        if (invalidCount>0) showDropStatus('technicians', `Se ignoraron ${invalidCount} archivo(s) sin extensión .xlsx.`, 'error');
        else showDropStatus('technicians','');
        if (!validTechs.length) return;

        const before = selectedTechnicians.length;
        selectedTechnicians = dedupeByName(selectedTechnicians.concat(validTechs));
        const added = selectedTechnicians.length - before;
        showDropStatus('technicians', added ? `Se agregaron ${added} archivo(s) de técnicos.` : 'Los archivos ya estaban en la lista.', 'info');

        trySyncInputFiles(techniciansInput, selectedTechnicians); // opcional
        renderTechnicians();   // <— pinta la lista y evalúa "Consolidar"
        }, 'technicians');

      // --- Submit / Cancel
      mergeCancelButton.addEventListener('click', function(){
        if (currentAbortController){ setStatus('Cancelando...', false); currentAbortController.abort(); }
      });
      function getFilenameFromContentDisposition(resp){
        const disp = resp.headers.get('content-disposition'); if (!disp) return null;
        const m = disp.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)"?/i); if (!m || !m[1]) return null;
        try{ return decodeURIComponent(m[1]); }catch(_){ return m[1]; }
      }
      function formatTimestamp(){ const n=new Date(),p=v=>String(v).padStart(2,'0'); return `${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}_${p(n.getHours())}${p(n.getMinutes())}`; }

      mergeForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        showValidationHints = true;

        const state = computeValidationMessage();
        if (state.message){ setStatus(state.message, true); updateSubmitState(); return; }

        setStatus('Preparando...', false);
        isSubmitting = true; updateSubmitState();
        currentAbortController = new AbortController();
        setStatus('Subiendo/Procesando...', false);

        try{
          const fd = new FormData();
          fd.append('master', masterFile);
          selectedTechnicians.forEach(f => fd.append('technicians', f));

          const resp = await fetch('/merge', { method:'POST', body: fd, signal: currentAbortController.signal });
          if (!resp.ok){
            let message = 'Error ' + resp.status;
            try {
              const data = await resp.clone().json();
              if (data && data.detail){
                message = data.detail;
              } else {
                const textFallback = await resp.text();
                if (textFallback){
                  message += ': ' + textFallback;
                }
              }
            } catch (_) {
              try {
                const textFallback = await resp.text();
                if (textFallback){
                  message += ': ' + textFallback;
                }
              } catch (_) {}
            }
            throw new Error(message);
          }
          const blob = await resp.blob();
          const filename = getFilenameFromContentDisposition(resp) || ('Consolidado_' + formatTimestamp() + '.xlsx');
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href=url; a.download=filename;
          document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
          setStatus('Listo.', false);
        }catch(err){
          if (err && err.name==='AbortError') setStatus('Operación cancelada.', false);
          else { console.error(err); setStatus('Error: ' + (err && err.message ? err.message : 'No se pudo consolidar.'), true); }
        }finally{
          isSubmitting = false; currentAbortController = null; updateSubmitState();
        }
      });

      // Init
      renderMaster();
      renderTechnicians();
      updateSubmitState();
    });
  </script>
</body>
</html>
"""
