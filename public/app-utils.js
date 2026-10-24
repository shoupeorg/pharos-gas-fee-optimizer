export function parseUtcDatetimeLocal(value){
  if(typeof value!=="string")throw new Error("Deadline must be entered as UTC.");
  const match=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if(!match)throw new Error("Deadline must use YYYY-MM-DDTHH:mm:ss in UTC.");
  const [,y,mo,d,h,mi,s="00"]=match,ms=Date.UTC(+y,+mo-1,+d,+h,+mi,+s);
  const date=new Date(ms);
  if(date.getUTCFullYear()!==+y||date.getUTCMonth()!==+mo-1||date.getUTCDate()!==+d||date.getUTCHours()!==+h||date.getUTCMinutes()!==+mi||date.getUTCSeconds()!==+s)throw new Error("Deadline is not a valid UTC date and time.");
  return date.toISOString();
}
export function formatUnits(value,decimals=18,places=9){const raw=BigInt(value),negative=raw<0n,v=negative?-raw:raw,base=10n**BigInt(decimals),whole=v/base,frac=(v%base).toString().padStart(decimals,"0").slice(0,places).replace(/0+$/,"");return`${negative?"-":""}${whole}${frac?`.`+frac:""}`;}
export const formatGwei=value=>value==null?"UNKNOWN":formatUnits(value,9,9);
