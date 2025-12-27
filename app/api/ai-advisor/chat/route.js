// app/api/ai-advisor/chat/route.js

// Standard imports
import { textModel } from "../../../lib/gemini"; // Gemini AI instance
import connectDB from "../../../lib/mongodb";
import Pet from "../../../models/PetModel";
// import { getSessionUser } from '../../../lib/auth'; // Placeholder for actual auth utility

// NOTE: In a production environment, this function MUST be replaced by a secure utility
// that extracts the authenticated user ID from the request headers (e.g., JWT) or session context.
function getCurrentUserId() {
  // This is a placeholder/stub. Implement secure authentication lookup here.
  // For the purpose of demonstration, let's assume the user ID is securely retrieved.
  // Example: return getSessionUser().id;
  
  // Since we cannot run actual authentication logic here, we simulate a constant user ID 
  // that we will intentionally mismatch with Pet B's ownerId to test the restriction logic.
  // In a real setup, this would return the ID of the logged-in user.
  return "AUTH_USER_123"; 
}


// Fetch pet details
async function getPetDetails(petId) {
  // Ensure the pet document includes the 'ownerId' field for authorization checks
  const pet = await Pet.findById(petId).lean(); 
  if (!pet) return null;

  // Handle missing names
  const sireInfo = pet.sireName || (pet.sireId ? "Registered (Name hidden)" : "Unknown");
  const damInfo = pet.damName || (pet.damId ? "Registered (Name hidden)" : "Unknown");

  return {
    ...pet,
    lineageInfo: `Sire: ${sireInfo}, Dam: ${damInfo}`
  };
}

// POST request handler
export async function POST(req) {
  try {
    await connectDB();
    
    // --- 1. AUTHENTICATION ---
    const currentUserId = getCurrentUserId();
    if (!currentUserId) {
        // User is not authenticated
        return new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 });
    }

    // Parse request body
    const { petAId, petBId, history, message } = await req.json();

    if (!petAId || !petBId) return new Response(JSON.stringify({ error: "IDs required" }), { status: 400 });

    // Fetch pet profiles
    const petA = await getPetDetails(petAId); // User's Pet
    const petB = await getPetDetails(petBId); // Target Pet 

    if (!petA || !petB) return new Response(JSON.stringify({ error: "Pets not found" }), { status: 404 });

    // --- 2. AUTHORIZATION CHECK FOR PET B's SENSITIVE DATA ---
    // Check if the current authenticated user owns Pet B
    const isOwnerOfPetB = petB.ownerId && petB.ownerId.toString() === currentUserId;
    
    let targetPet = petB;
    let authorizationStatus = "FULL PROFILE (Owner access)";

    if (!isOwnerOfPetB) {
        // UNAUTHORIZED ACCESS: Sanitize sensitive fields before passing to the AI model.
        
        targetPet = {
            ...petB,
            
            // Critical Sanitize: Strip sensitive medical records
            medicalHistoryLog: "Access Restricted. Medical history logs are hidden from non-owners for privacy reasons.",
            vaccinationHistory: [], // Clear the array to prevent detailed exposure
            
            // Sanitize Lineage details (which might include hidden registry IDs or specific names)
            lineageInfo: petB.lineageInfo.includes("Unknown") 
                ? "Lineage information not provided." 
                : "Lineage details masked for privacy (Registered ancestry).",
        };
        authorizationStatus = "RESTRICTED PROFILE (Non-Owner access)";
    }

    // Format vaccination list using the potentially sanitized targetPet records
    const vaxList = targetPet.vaccinationHistory && targetPet.vaccinationHistory.length > 0
        ? targetPet.vaccinationHistory.map(v => `- ${v.vaccineName} (Expires: ${new Date(v.expiryDate).toLocaleDateString()})`).join("\n")
        : "No vaccination records visible.";

    // Define AI instructions
    const systemPrompt = `
      You are an expert Pet Advisor and Geneticist.
      The user (owner of Pet A) is asking about Pet B (the target pet).
      
      [SECURITY STATUS: ${authorizationStatus}]

      **TARGET PET (PET B) DETAILS:**
      - Name: ${targetPet.name}
      - Species: ${targetPet.type}
      - Breed: ${targetPet.breed}
      - Age: ${targetPet.age}
      - Lineage: ${targetPet.lineageInfo}
      
      **MEDICAL HISTORY LOG (From Dr. Paws):**
      """
      ${targetPet.medicalHistoryLog || "No specific medical issues recorded."}
      """

      **VACCINATION STATUS:**
      ${vaxList}

      **USER'S PET (PET A - For Compatibility Context):**
      - Name: ${petA.name}
      - Breed: ${petA.breed}
      - Species: ${petA.type}

      **INSTRUCTIONS:**
      1. Answer questions specifically about Pet B's health, history, or traits using the data above.
      2. If the user asks about "medical details", "surgery", or "illness", YOU MUST summarize the "MEDICAL HISTORY LOG" provided above.
      3. If the log is empty/default or restricted, state that no history is available or that access is restricted.
      4. If asked about offspring, analyze compatibility based on Breed/Species.
    `;

    // Initialize chat history
    const chat = textModel.startChat({
      history: [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: `I have reviewed ${targetPet.name}'s profile. What would you like to know?` }] },
        ...history // Add user history
      ]
    });

    // Get AI response
    const result = await chat.sendMessage(message);
    const responseText = result.response.text();

    return new Response(JSON.stringify({ text: responseText }), { status: 200 });

  } catch (err) {
    console.error("Advisor Error:", err);
    return new Response(JSON.stringify({ error: "Failed to generate advice" }), { status: 500 });
  }
}