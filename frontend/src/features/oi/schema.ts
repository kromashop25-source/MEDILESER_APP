import { z } from "zod";

const NumerationTypeValues = ["correlativo", "no correlativo"] as const;


export const OISchema = z.object({
  oi: z.string().regex(/^OI-\d{4}-\d{4}$/, "Formato OI-####-YYYY"),
  q3: z.number(),
  alcance: z.number(),
  pma: z
    .number()
    .refine((v) => v === 10 || v === 16, { message: "PMA inválido" }),
  numeration_type: z.enum(NumerationTypeValues).default("correlativo"),
});

export type OIForm = z.infer<typeof OISchema>;
export type OIFormInput = z.input<typeof OISchema>;

const QBlockSchema = z.object({
  c1: z.number().optional().nullable(),
  c2: z.number().optional().nullable(),
  c3: z.number().optional().nullable(),
  c4: z.number().optional().nullable(),
  c5: z.number().optional().nullable(),
  c6: z.number().optional().nullable(),
  // c7 ahora es TEXTO para "2,31,120"
  c7: z.string().optional().nullable(), 
  // Campo auxiliar para guardar los segundos calculados (ej: 151.120)
  c7_seconds: z.number().optional().nullable(),
  // Campos calculados (visuales)
  caudal: z.number().optional().nullable(),
  error: z.number().optional().nullable(),
});

export const BancadaRowSchema = z.object({
  medidor: z.string().optional(),
  // Estado individual por medidor (0=Conforme, 1=Daño, etc.)
  estado: z.number().int().min(0).max(5).default(0),
  q3: QBlockSchema.optional(),
  q2: QBlockSchema.optional(),
  q1: QBlockSchema.optional(),
  // Resultado final
  conformidad: z.string().optional(),
});

export type BancadaRowForm = z.infer<typeof BancadaRowSchema>;

export const bancadaFormSchema = z.object({
  estado: z.number().int().min(0).optional(), // Ya no es obligatorio globalmente
  rows: z.number().int().min(1).default(15),
  rowsData: z.array(BancadaRowSchema),
});
export type BancadaForm = z.infer<typeof bancadaFormSchema>;

export function pressureFromPMA(pma?: number): number {
  if (pma === 16) return 25.6;
  if (pma === 10) return 16.0;
  return NaN;
}
