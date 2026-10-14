import sharp from 'sharp';
async function bytes(stream){
  const parts=[];let size=0;
  for await(const part of stream){size+=part.length;if(size>20*1024*1024)throw Error('Image source exceeds its bound.');parts.push(part);}
  return Buffer.concat(parts);
}
const decoder=source=>sharp(source,{limitInputPixels:100000000,failOn:'warning',animated:false});
export const images={
  async info(stream){const m=await decoder(await bytes(stream)).metadata();return {width:m.width,height:m.height,format:m.format};},
  input(stream){
    const source=bytes(stream);let options={};
    const chain={transform(value){
      if(!value||Object.keys(value).some(k=>!['width','fit'].includes(k))||!Number.isInteger(value.width)||value.width<1||value.width>4096||value.fit!=='scale-down')throw Error('Unsupported bounded image transform.');
      options=value;return chain;
    },async output({format,quality}){
      if(!['image/webp','image/jpeg','image/png'].includes(format)||!Number.isInteger(quality)||quality<1||quality>100)throw Error('Unsupported image output.');
      let image=decoder(await source).rotate();if(options.width)image=image.resize({width:options.width,withoutEnlargement:true});
      const result=await image.toFormat(format.slice(6),{quality}).toBuffer();
      return {response:()=>new Response(result,{headers:{'content-type':format,'content-length':String(result.length)}})};
    }};return chain;
  }
};
