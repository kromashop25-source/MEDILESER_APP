import { useMemo, useState } from "react";
import axios from "axios";
import type { AxiosError } from "axios";
import {
  log02ValidarRutasUnc,
  type Log02ValidarRutasUncResponse,
} from "../../api/oiTools";

function badge(ok?: boolean | null) {
  if (ok === true) return "badge bg-success";
  if (ok === false) return "badge bg-danger";
  return "badge bg-secondary";
}

export default function Log02PdfPage() {

  const [rutasOrigen, setRutasOrigen] = useState<string[]>([""]);
  const [rutaDestino, setRutaDestino] = useState<string>("");
  const [validando, setValidando] = useState<boolean>(false);
  const [error, setError ] = useState<string>("");
  const [resultado, setResultado] = useState<Log02ValidarRutasUncResponse | null>(null);

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
                  <input
                    className="form-control form-control-sm"
                    value={rutaDestino}
                    onChange={(e) => setRutaDestino(e.target.value)}
                    placeholder="\\\\SERVIDOR\\Compartido\\Salida_LOG02"
                    disabled={validando}
                  />
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
    </div>
  );
}
