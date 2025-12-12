import { api } from "./client";

export type Catalogs = {
  q3: number[];
  alcance: number[];
  pma: number[];
  bancos: { id:number; name:string }[];
};

export const getCatalogs = async (): Promise<Catalogs> => {
  const { data } = await api.get("/catalogs");
  return data;
};
