// The browser renders the original DOM with its own fonts/CSS, including OKLCH.
// Inline only the two bundled receipt fonts; no fetch or iframe is required.
import {toCanvas} from 'html-to-image';
import regular from '../../assets/fonts/dmmono.ttf?inline';
import medium from '../../assets/fonts/dmmono500.ttf?inline';
const fontEmbedCSS=`@font-face{font-family:NativeDMMono;src:url('${regular}') format('truetype');font-weight:400;}@font-face{font-family:NativeDMMono;src:url('${medium}') format('truetype');font-weight:500;}`;
export async function captureReceipt(element:HTMLElement,dots:number){
 const width=element.getBoundingClientRect().width,height=element.scrollHeight,ratio=dots/width;
 if(width<=0||height<=0||Math.ceil(height*ratio)>20000)throw{code:'PRINT_RASTER_INVALID'};
 return toCanvas(element,{backgroundColor:'#fff',width,height,canvasWidth:width,pixelRatio:ratio,skipAutoScale:true,fontEmbedCSS,style:{margin:'0'},filter:node=>!(node instanceof HTMLElement&&node.classList.contains('native-ticket-second-copy'))});
}
