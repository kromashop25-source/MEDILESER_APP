import { useMemo, useState } from "react";
import axios from "axios";
import type { AxiosError } from "axios";
import {
  log02ValidarRutasUnc,
  type Log02ValidarRutasUncResponse,
  log02ExplorerRoots,
  log02ExplorerListar,
  type Log02ExplorerListItem,
} from "../../api/oiTools";

function badge(ok?: boolean | null) {
  if (ok === true) return "badge bg-success";
  if (ok === false) return "badge bg-danger";
  return "badge bg-secondary";
}

type ExplorerMode = "origen" | "destino";

export default function Log02PdfPage() {

  const [rutasOrigen, setRutasOrigen] = useState<string[]>([""]);
  const [rutaDestino, setRutaDestino] = useState<string>("");
  const [validando, setValidando] = useState<boolean>(false);
  const [error, setError ] = useState<string>("");
  const [resultado, setResultado] = useState<Log02ValidarRutasUncResponse | null>(null);

  // Explorador (modal inline)
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [explorerMode, setExplorerMode] = useState<ExplorerMode>("origen");
  const [roots, setRoots] = useState<string[]>([]);
  const [rootSel, setRootSel] = useState<string>("");
  const [currentPath, setCurrentPath] = useState<string>("");
  const [folders, setFolders] = useState<Log02ExplorerListItem[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [explorerError, setExplorerError] = useState<string>("");


  const origenesLimpios = useMemo(
    () => rutasOrigen.map((x) => (x ?? "").trim()),
    [rutasOrigen]
  );

  function setOrigenAt(i: number, value: string) {
    setRutasOrigen((prev) => {
      const next = prev.slice();
      next[i]  = value;
      return next;
    });
  }

  function addOrigen() {
    setRutasOrigen((prev) => [...prev, ""]);
  }

  function removeOrigen(i: number) {
    setRutasOrigen((prev) => {
      if (prev.length <= 1) return prev; // mantener al menos 1 input
      const next = prev.slice();
      next.splice(i, 1);
      return next;
    });
  }

  async function openExplorer(mode:ExplorerMode) {
    setExplorerMode(mode);
    setExplorerError("");
    setExplorerOpen(true);
    try {
      const res = await log02ExplorerRoots();
      const rs = res.roots || [];
      setRoots(rs);
      const first = rs[0] || "";
      setRootSel(first);
      setCurrentPath(first);
      if (first) {
        await loadFolders(first);
      } else {
        setFolders([]);
        setExplorerError("No hay rutas raíz configuradas para el explorador. Configure VI_LOG02_UNC_ROOTS en el servidor.");
      }
    } catch (e) {
      const ax = e as AxiosError<any>;
      const detail = 
      (ax.response?.data?.detail as string) ||
      ax.message ||
      "No se pudo cargar las rutas raíz.";
      setExplorerError(detail);
      setFolders([]);
    }
  }

  async function loadFolders(path: string) {
    setExplorerError("");
    if (!path) {
      setFolders([]);
      return;
    }
    try {
      setLoadingFolders(true);
      const res = await log02ExplorerListar(path);
      setCurrentPath(res.path);
      setFolders(res.folders || []);
    } catch (e) {
      const ax = e as AxiosError<any>;
      const detail =
      (ax.response?.data?.detail as string) ||
      ax.message ||
      "No se pudo listar la carpeta.";
      setExplorerError(detail);
      setFolders([]);
    } finally {
      setLoadingFolders(false);
    }
  }

  function upOneLevel() {
    // Subir un nivel: recortamos por separador de Windows "\".
    // Mantener dentro de la raíz: el backend bloqueará si sale del allowlist.
    const p = (currentPath || "").replace(/[\\\/]+$/, "");
    const idx = p.lastIndexOf("\\");
    if (idx <= 0) return;
    const parent = p.slice(0, idx);
    void loadFolders(parent);
  }

  function selectCurrentFolder() {
    if (!currentPath) return;
    if (explorerMode === "destino") {
      setRutaDestino(currentPath);
    } else {
      // agregar como nuevo origen, evitando duplicado exacto
      setRutasOrigen((prev) =>  {
        const clean = currentPath.trim();
        if (!clean) return prev;
        if (prev.map((x) => (x || "").trim()).includes(clean)) return prev;
        // si el primer input está vacío, lo reemplazamos
        if (prev.length === 1 && !(prev[0] || "").trim()) return [clean]
        return [...prev, clean];
      });
    }
    setExplorerOpen(false);
  }

  async function validar() {
    setError("");
    setResultado(null);
    const destinos = (rutaDestino ?? "").trim();
    const origenes = origenesLimpios.filter((x) => x);
    
    if (!origenes.length) {
      setError("Debes ingresar al menos una ruta de origen.");
      return;
    }
    if (!destinos) {
      setError("Debes ingresar una ruta de destino.");
      return;
    }

    try {
      setValidando(true);
      const res = await log02ValidarRutasUnc({
        rutas_origen: origenes,
        ruta_destino: destinos,
      });
      setResultado(res);
      if (!res.ok) {
        setError("Validación incompleta: revisa los detalles de permisos y existencia.");
      }
    } catch (e) {
      const ax = e as AxiosError<any>;
      if (axios.isCancel(ax)) return;
      const detail =
      (ax.response?.data?.detail as string) ||
      ax.message ||
      "No se pudo validar las rutas.";
      setError(detail);
    } finally {
      setValidando(false);
    }

  }


  return (
    <div className="container-fluid">
      <div className="row">
        <div className="col-12">
          <div className="bd bgc-white p-20 mB-20">
            <h4 className="c-grey-900 mB-10">Filtrado de certificados PDF (LOG-02)</h4>
            <div className="text-muted small">
              Este módulo se orienta a <strong>copiar</strong> y <strong>filtrar</strong> certificados PDF desde una
              <strong> carpeta compartida</strong> (no ZIP).<br />
              Configura las rutas UNC y valida accesos antes de iniciar el filtrado.
            </div>

            {error ? (
              <div className="alert alert-danger mT-15" role="alert">
                {error}
              </div>
            ) : null}

            <div className="mT-15">
              <h6 className="c-grey-900 mB-10">Rutas UNC</h6>

              <div className="row g-2">
                <div className="col-12">
                  <label className="form-label">Rutas origen (UNC) — lectura</label>

                  {rutasOrigen.map((value, i) => (
                    <div key={i} className="d-flex gap-10 mB-10">
                      <input
                        className="form-control form-control-sm"
                        value={value}
                        onChange={(e) => setOrigenAt(i, e.target.value)}
                        placeholder="\\\\SERVIDOR\\Compartido\\Certificados"
                        disabled={validando}
                      />
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-primary"
                        onClick={() => void openExplorer("origen")}
                        disabled={validando}
                        title="Elegir carpeta"
                      >
                        Elegir
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        onClick={addOrigen}
                        disabled={validando}
                        title="Agregar ruta"
                      >
                        +
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        onClick={() => removeOrigen(i)}
                        disabled={validando || rutasOrigen.length <= 1}
                        title="Quitar ruta"
                      >
                        –
                      </button>
                    </div>
                  ))}

                  <div className="small text-muted">
                    Nota: estas rutas deben ser accesibles <strong>desde el servidor</strong> donde corre el backend.
                  </div>
                </div>

                <div className="col-12 col-md-8">
                  <label className="form-label">Ruta destino (UNC) — lectura y escritura</label>
                  <div className="d-flex gap-10">
                    <input
                      className="form-control form-control-sm"
                      value={rutaDestino}
                      onChange={(e) => setRutaDestino(e.target.value)}
                      placeholder="\\\\SERVIDOR\\Compartido\\Salida_LOG02"
                      disabled={validando}
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-primary"
                      onClick={() => void openExplorer("destino")}
                      disabled={validando}
                      title="Elegir carpeta"
                    >
                      Elegir
                    </button>
                  </div>
                </div>

                <div className="col-12 col-md-4 d-flex align-items-end">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary w-100"
                    onClick={() => void validar()}
                    disabled={validando}
                  >
                    {validando ? "Validando..." : "Validar"}
                  </button>
                </div>
              </div>
            </div>

            {resultado ? (
              <div className="mT-20">
                <h6 className="c-grey-900 mB-10">Resultado de validación</h6>

                <div className="table-responsive">
                  <table className="table table-sm mB-0">
                    <thead>
                      <tr className="small">
                        <th style={{ whiteSpace: "nowrap" }}>Tipo</th>
                        <th>Ruta</th>
                        <th style={{ whiteSpace: "nowrap" }}>Existe</th>
                        <th style={{ whiteSpace: "nowrap" }}>Lectura</th>
                        <th style={{ whiteSpace: "nowrap" }}>Escritura</th>
                        <th>Detalle</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resultado.origenes.map((o, idx) => (
                        <tr key={`o-${idx}`} className="small">
                          <td style={{ whiteSpace: "nowrap" }}><strong>Origen</strong></td>
                          <td style={{ wordBreak: "break-all" }}>{o.ruta || "N/D"}</td>
                          <td><span className={badge(o.existe)}>{o.existe ? "Sí" : "No"}</span></td>
                          <td><span className={badge(o.lectura)}>{o.lectura ? "Sí" : "No"}</span></td>
                          <td><span className={badge(null)}>—</span></td>
                          <td>{o.detalle || ""}</td>
                        </tr>
                      ))}

                      <tr className="small">
                        <td style={{ whiteSpace: "nowrap" }}><strong>Destino</strong></td>
                        <td style={{ wordBreak: "break-all" }}>{resultado.destino.ruta || "N/D"}</td>
                        <td><span className={badge(resultado.destino.existe)}>{resultado.destino.existe ? "Sí" : "No"}</span></td>
                        <td><span className={badge(resultado.destino.lectura)}>{resultado.destino.lectura ? "Sí" : "No"}</span></td>
                        <td>
                          <span className={badge(!!resultado.destino.escritura)}>
                            {resultado.destino.escritura ? "Sí" : "No"}
                          </span>
                        </td>
                        <td>{resultado.destino.detalle || ""}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {resultado.ok ? (
                  <div className="alert alert-success mT-15" role="alert">
                    Rutas validadas correctamente. Puedes continuar con la siguiente fase.
                  </div>
                ) : (
                  <div className="alert alert-warning mT-15" role="alert">
                    Hay rutas con problemas. Corrige existencia/permisos y vuelve a validar.
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {/* Modal explorador (inline Bootstrap/Adminator) */}
      {explorerOpen ? (
        <>
          <div className="modal fade show" style={{ display: "block" }} role="dialog" aria-modal="true">
            <div className="modal-dialog modal-lg" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">
                    {explorerMode === "destino" ? "Elegir carpeta de destino" : "Elegir carpeta de origen"}
                  </h5>
                  <button type="button" className="close" aria-label="Close" onClick={() => setExplorerOpen(false)}>
                    <span aria-hidden="true">&times;</span>
                  </button>
                </div>

                <div className="modal-body">
                  {explorerError ? (
                    <div className="alert alert-danger" role="alert">
                      {explorerError}
                    </div>
                  ) : null}

                  <div className="row g-2">
                    <div className="col-12 col-md-6">
                      <label className="form-label">Raíz</label>
                      <select
                        className="form-control form-control-sm"
                        value={rootSel}
                        onChange={(e) => {
                          const v = e.target.value;
                          setRootSel(v);
                          void loadFolders(v);
                        }}
                        disabled={!roots.length}
                      >
                       {roots.length ? (
                          roots.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))
                        ) : (
                          <option value="">Sin raíces</option>
                        )}
                      </select>
                    </div>

                    <div className="col-12 col-md-6">
                      <label className="form-label">Carpeta actual</label>
                      <input className="form-control form-control-sm" value={currentPath} readOnly />
                    </div>
                  </div>

                  <div className="d-flex gap-10 mT-10">
                    <button type="button" className="btn btn-sm btn-outline-secondary" onClick={upOneLevel} disabled={!currentPath || loadingFolders}>
                      Subir nivel
                    </button>
                    <button type="button" className="btn btn-sm btn-primary" onClick={selectCurrentFolder} disabled={!currentPath || loadingFolders}>
                      Seleccionar esta carpeta
                    </button>
                  </div>

                  <hr />

                  {loadingFolders ? (
                    <div className="text-muted small">Cargando carpetas...</div>
                  ) : (
                    <div className="table-responsive">
                      <table className="table table-sm mB-0">
                        <thead>
                          <tr className="small">
                            <th>Subcarpetas</th>
                            <th style={{ width: 120 }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {folders.length ? (
                            folders.map((f) => (
                              <tr key={f.path} className="small">
                                <td style={{ wordBreak: "break-all" }}>{f.name}</td>
                                <td>
                                  <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => void loadFolders(f.path)}>
                                    Entrar
                                  </button>
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr className="small">
                             <td colSpan={2} className="text-muted">
                               Sin subcarpetas o sin permisos para listar.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="modal-footer">
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => setExplorerOpen(false)}>
                    Cerrar
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      ) : null}
    </div>
  );
}
