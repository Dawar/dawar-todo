// Entirely synthetic/public fixtures; no account, native process or file reads.
export function syntheticConversation(turnCount = 150, toolCount = 40) {
const text=(id,type,value)=> type==='userMessage' ? {id,type,clientId:'request-'+id,content:[{type:'text',text:value,text_elements:[]}]} : {id,type,text:value,phase:'final_answer',delivery:null,memoryCitation:null,questions:null};
const turns=Array.from({length:turnCount},(_,i)=>({id:'turn-'+i,status:'completed',startedAt:1789891200+i,itemsView:'full',items:[
text('u-'+i,'userMessage',`Question ${i}: Please help me plan a thoughtful week.`),
{id:'r-'+i,type:'reasoning',summary:['Compare the available options and keep the plan simple.'],content:['PRIVATE SYNTHETIC FIELD MUST NOT TRANSFER']},
...Array.from({length:toolCount},(_,j)=>({id:`tool-${i}-${j}`,type:'commandExecution',command:'synthetic review',status:'completed',aggregatedOutput:'synthetic output '.repeat(200)})),
text('a-'+i,'agentMessage',`### Answer ${i}\n\nChoose a meaningful outcome, give it your best hour, and leave room to reflect.\n\nKeep the next step small and useful.\n\n- Prepare your materials.\n- Make a first draft.\n- Review with fresh eyes.`)
]}));
return turns;
}
